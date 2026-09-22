/**
 * Keadaan satu Boo Code web: agent, sesi, antrean, izin, dan pertanyaan.
 *
 * Satu server melayani satu workspace — direktori tempat `boo-code web` dijalankan.
 * Semua tab yang terbuka berlangganan event yang sama; menjawab izin di satu tab
 * menutup pertanyaannya di tab lain, dan menutup tab tidak menghentikan pekerjaan.
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import {
  acceptedEffort,
  aggregateLocalTraces,
  automaticReviewEnabled,
  Agent,
  backgroundProcesses,
  condense,
  createDefaultRegistry,
  describeSelection,
  designPrompt,
  diffStats,
  evaluatePermission,
  expandPromptCommand,
  FEATURED_FAMILIES,
  findSelection,
  formatTaskStatus,
  groupModels,
  imageDataUrl,
  INIT_PROMPT,
  inspectSandbox,
  type ModelMode,
  listSpecs,
  findApp,
  launchApp,
  loadApps,
  loadInstructions,
  loadSkills,
  loadPromptCommands,
  loadHooks,
  loadPermissionPolicy,
  storeImageData,
  validateImages,
  latestInterruptedRun,
  latestPlan,
  latestTodos,
  LocalRunTrace,
  PersistentRunJournal,
  NineRouterProvider,
  nextTask,
  readSpec,
  requirementsPrompt,
  reviewRequest,
  implementPlanRequest,
  planRequest,
  permissionRuleLabel,
  resolveInWorkspace,
  resolveConfiguredPermission,
  resolveShell,
  resolveSandboxPolicy,
  revisePrompt,
  specPromptTitle,
  SPECS_DIRECTORY,
  taskPrompt,
  tasksPrompt,
  uniqueSpecName,
  runCommand,
  traceAgentEvents,
  journalAgentEvents,
  runRecoveryPrompt,
  tracingEnabled,
  type AgentEvent,
  type Compaction,
  type DiffLine,
  type ImageAttachment,
  type Message,
  type PermissionDecision,
  type ProviderOptions,
  type SpecDocument,
  type SpecTask,
  type UserAnswer,
  type UserQuestion,
  profilesFromConfig,
  defaultProfile,
  listAnthropicModels,
  PROVIDER_DEFINITIONS,
  providerDefinition,
  type ProviderProfile,
  DashboardError,
  gatherQuota,
  loginToDashboard,
  providerLabel,
} from '@boo/core'
import { GLOBAL_CONFIG_PATH, updateEnvFile, type BooKey } from '@boo/core/config/config.ts'
import { describeRequest, languageOf } from '@boo/core/presentation/approval.ts'
import { buildTranscript } from '@boo/core/presentation/transcript.ts'
import type { ViewItem } from '@boo/core/presentation/view.ts'
import { forkSession as forkStoredSession, forkSessionAt, listSessions, loadSession, sessionTurns, SessionRecorder, shortId } from '@boo/core/session/sessions.ts'
import type {
  DiffRow,
  ModelFamilyView,
  ModelView,
  QuestionBody,
  QuestionOption,
  QuestionView,
  ServerEvent,
  SessionView,
  Snapshot,
  ProviderStatusView,
  QuotaReportView,
  SpecView,
  StatusView,
} from '../protocol.ts'
import { RequestPresenter } from './presenter.ts'

export const DEFAULT_MODEL = 'ag/gemini-3.1-pro'
export const DEFAULT_BASE_URL = 'http://localhost:20128'
/** Sesi panjang dibatasi pada tukar-jawab terakhir agar halaman tetap ringan. */
export const MAX_REPLAYED_EXCHANGES = 30
/** Diff raksasa tidak dikirim utuh ke halaman. */
const MAX_DIFF_ROWS = 600

export class ControllerError extends Error {
  readonly status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

export interface ControllerOptions {
  workspace: string
  config: Partial<Record<BooKey, string | undefined>>
  version: string
  /** Untuk berkas aturan pribadi ~/.boo/BOO.md; bawaannya direktori rumah pengguna. */
  home?: string
  /** Diganti di test dengan provider palsu. */
  createProvider?: (options: ProviderOptions) => NineRouterProvider
  /** Jeda pengulangan panggilan model; dipersingkat di test. */
  retryDelaysMs?: number[]
  /** Berkas setelan yang ditulis saat penyedia diubah dari halaman web. */
  configPath?: string
}

interface Job {
  /** Yang tampil sebagai pertanyaan pengguna. */
  display: string
  prompt: string
  kind: 'send' | 'compact'
  mode?: 'normal' | 'review' | 'plan'
  /** Dijalankan hanya bila permintaan selesai normal. */
  after?: () => Promise<void>
  images?: ImageAttachment[]
}

interface QueuedInput { text: string; images: ImageAttachment[] }

interface PendingQuestion {
  view: QuestionView
  resolve: (answer: { optionId: string; text: string }) => void
}

type Listener = (event: ServerEvent) => void

export class WebController {
  private readonly options: ControllerOptions
  /** Setelan yang berlaku; berubah saat penyedia diatur dari halaman web. */
  private readonly settings: Record<string, string | undefined>
  private readonly workspace: string
  private readonly provider: NineRouterProvider
  private modelMode: ModelMode
  private recorder: SessionRecorder
  private agent: Agent
  private items: ViewItem[] = []
  private omittedExchanges = 0
  private busy = false
  private abort: AbortController | null = null
  private presenter: RequestPresenter | null = null
  private readonly queue: QueuedInput[] = []
  private internal: Job | null = null
  private status: StatusView | null = null
  private question: PendingQuestion | null = null
  private readonly sessionApprovals = new Set<string>()
  private readonly listeners = new Set<Listener>()
  private counter = 0
  private processing = false

  constructor(options: ControllerOptions) {
    this.options = options
    this.settings = { ...options.config }
    this.workspace = options.workspace
    this.modelMode = options.config.BOO_MODEL && options.config.BOO_MODEL !== 'auto' ? 'manual' : 'auto'
    const model = this.modelMode === 'auto' ? DEFAULT_MODEL : options.config.BOO_MODEL || DEFAULT_MODEL
    const providerOptions: ProviderOptions = {
      baseUrl: options.config.NINEROUTER_URL || DEFAULT_BASE_URL,
      apiKey: options.config.NINEROUTER_KEY ?? '',
      profiles: profilesFromConfig(options.config),
      model,
      reasoningEffort: this.modelMode === 'auto' ? undefined : acceptedEffort(model, options.config.BOO_EFFORT),
      home: options.home ?? homedir(),
    }
    this.provider = options.createProvider?.(providerOptions) ?? new NineRouterProvider(providerOptions)
    this.recorder = this.newRecorder()
    this.agent = this.createAgent()
  }

  /* ------------------------------------------------------------ langganan */

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    listener({ type: 'snapshot', snapshot: this.snapshot() })
    return () => this.listeners.delete(listener)
  }

  snapshot(): Snapshot {
    return {
      version: this.options.version,
      workspace: this.workspace,
      model: this.modelView(),
      sessionId: this.recorder.started ? this.recorder.id : null,
      items: this.items,
      omittedExchanges: this.omittedExchanges,
      busy: this.busy,
      queue: this.queue.map((item) => item.text),
      status: this.status,
      question: this.question?.view ?? null,
      instructions: this.agent.instructions.map((file) => file.label),
      commands: loadPromptCommands({ workspace: this.workspace, home: this.options.home ?? homedir() }).map(({ name, description, source }) => ({ name, description, source })),
    }
  }

  private emit(event: ServerEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // Tab yang terputus tidak boleh menghentikan tab lain.
      }
    }
  }

  private nextId(): string {
    this.counter += 1
    return `w${this.counter}`
  }

  /* ------------------------------------------------------------ unsur tampilan */

  private putItem(item: ViewItem, toEnd = false): void {
    const index = this.items.findIndex((existing) => existing.id === item.id)
    if (index === -1) this.items.push(item)
    else if (toEnd) {
      this.items.splice(index, 1)
      this.items.push(item)
    } else this.items[index] = item
    this.emit({ type: 'item', item, ...(toEnd ? { toEnd: true } : {}) })
  }

  private appendText(id: string, text: string): void {
    const item = this.items.find((existing) => existing.id === id)
    if (item?.kind !== 'answer') return
    item.markdown += text
    this.emit({ type: 'append', id, text })
  }

  private notice(variant: Extract<ViewItem, { kind: 'notice' }>['variant'], text: string): void {
    this.putItem({ kind: 'notice', id: this.nextId(), variant, text })
  }

  private setStatus(status: StatusView | null): void {
    this.status = status
    this.emit({ type: 'status', status })
  }

  private setBusy(busy: boolean): void {
    this.busy = busy
    this.emit({ type: 'busy', busy })
  }

  private emitQueue(): void {
    this.emit({ type: 'queue', queue: this.queue.map((item) => item.text) })
  }

  /* ------------------------------------------------------------ agent dan sesi */

  private newRecorder(resumeId?: string): SessionRecorder {
    return new SessionRecorder({
      workspace: this.workspace,
      model: this.provider.model,
      modelMode: this.modelMode,
      ...(this.provider.reasoningEffort ? { reasoningEffort: this.provider.reasoningEffort } : {}),
      ...(resumeId ? { resumeId } : {}),
    })
  }

  private createAgent(history?: Message[], compaction?: Compaction): Agent {
    const recorder = () => this.recorder
    const home = this.options.home ?? homedir()
    const recovery = history ? latestInterruptedRun(home, this.workspace, this.recorder.id) : null
    return new Agent({
      provider: this.provider,
      modelMode: this.modelMode,
      registry: createDefaultRegistry(),
      workspace: this.workspace,
      home,
      autoReview: automaticReviewEnabled(this.options.config.BOO_AUTO_REVIEW),
      sessionId: this.recorder.id,
      ...(recovery ? { recoveryPrompt: runRecoveryPrompt(recovery, latestTodos(history ?? []), history ?? []) } : {}),
      sandbox: resolveSandboxPolicy(this.options.config.BOO_SANDBOX, this.options.config.BOO_NETWORK_ACCESS),
      instructions: (targets) => loadInstructions({ workspace: this.workspace, home: this.options.home ?? homedir(), targets }),
      skills: () => loadSkills({ workspace: this.workspace, home: this.options.home ?? homedir() }),
      hooks: () => loadHooks(this.workspace, this.options.home ?? homedir()),
      ...(Number(this.options.config.BOO_MAX_TURNS) > 0 ? { maxTurns: Number(this.options.config.BOO_MAX_TURNS) } : {}),
      ...(this.options.config.BOO_MAX_CONTEXT_TOKENS ? { maxContextTokens: Number(this.options.config.BOO_MAX_CONTEXT_TOKENS) } : {}),
      ...(this.options.retryDelaysMs ? { retryDelaysMs: this.options.retryDelaysMs } : {}),
      ...(history ? { history } : {}),
      ...(compaction ? { compaction } : {}),
      onMessage: (message) => recorder().recordMessage(message),
      onCompaction: (summary) => recorder().recordCompaction(summary),
      askUser: (question) => this.askUser(question),
      askPermission: (request) => this.askPermission(request),
      onTurnLimit: (turns) => this.askTurnLimit(turns),
    })
  }

  sessions(): SessionView[] {
    const currentId = this.recorder.started ? this.recorder.id : null
    return listSessions(this.workspace).map((session) => ({
      id: session.id,
      title: session.title,
      updatedAt: session.updatedAt,
      current: session.id === currentId,
    }))
  }

  newSession(): void {
    this.requireIdle()
    this.dismissQuestion()
    this.recorder = this.newRecorder()
    this.agent = this.createAgent()
    this.items = []
    this.omittedExchanges = 0
    this.queue.length = 0
    this.internal = null
    this.sessionApprovals.clear()
    this.emit({ type: 'snapshot', snapshot: this.snapshot() })
  }

  resumeSession(id: string): void {
    this.requireIdle()
    let session
    try {
      session = loadSession(id)
    } catch (error) {
      throw new ControllerError(error instanceof Error ? error.message : 'Sesi tidak dapat dimuat.', 404)
    }
    // Riwayatnya merujuk berkas di direktori asal; melanjutkan di sini akan menyentuh berkas yang keliru.
    if (session.workspace !== this.workspace) throw new ControllerError('Sesi itu milik direktori lain.', 403)
    this.dismissQuestion()
    if (session.model) {
      this.provider.model = session.model
      this.provider.reasoningEffort = acceptedEffort(session.model, session.reasoningEffort)
    }
    this.modelMode = session.modelMode ?? 'manual'
    this.recorder = this.newRecorder(session.id)
    this.agent = this.createAgent(session.messages, session.compaction)
    const exchanges = buildTranscript(session.messages)
    const shown = exchanges.slice(-MAX_REPLAYED_EXCHANGES)
    this.omittedExchanges = exchanges.length - shown.length
    this.items = shown.flat()
    this.queue.length = 0
    this.internal = null
    this.sessionApprovals.clear()
    const restored = this.agent.restored
    if (restored?.filledToolResults || restored?.filledReplies) {
      this.items.push({ kind: 'notice', id: this.nextId(), variant: 'info', text: 'Sesi sebelumnya berhenti mendadak; bagian yang terputus sudah ditandai.' })
    }
    const interrupted = latestInterruptedRun(this.options.home ?? homedir(), this.workspace, session.id)
    if (interrupted) {
      const details = [
        interrupted.activeTools.length ? `${interrupted.activeTools.length} tool belum pasti` : '',
        interrupted.checkpoint?.files.length ? `${interrupted.checkpoint.files.length} file terdampak` : '',
        interrupted.verificationNeeded ? 'verifikasi tertunda' : '',
      ].filter(Boolean)
      this.items.push({ kind: 'notice', id: this.nextId(), variant: 'info', text: `Run sebelumnya terputus pada langkah ${Math.max(1, interrupted.lastTurn + 1)}${details.length ? ` · ${details.join(' · ')}` : ''}. Boo akan memeriksa keadaan workspace sebelum melanjutkan.` })
    }
    this.emit({ type: 'snapshot', snapshot: this.snapshot() })
  }

  forkSession(): void {
    this.requireIdle()
    if (!this.recorder.started) throw new ControllerError('Belum ada percakapan untuk dicabangkan. Kirim satu pesan terlebih dahulu.')
    const sourceId = this.recorder.id
    let session
    try {
      session = forkStoredSession(sourceId)
    } catch (error) {
      throw new ControllerError(error instanceof Error ? error.message : 'Sesi tidak dapat dicabangkan.')
    }
    if (session.workspace !== this.workspace) throw new ControllerError('Sesi itu milik direktori lain.', 403)

    this.dismissQuestion()
    this.modelMode = session.modelMode ?? 'manual'
    if (session.model) {
      this.provider.model = session.model
      this.provider.reasoningEffort = acceptedEffort(session.model, session.reasoningEffort)
    }
    this.recorder = this.newRecorder(session.id)
    this.agent = this.createAgent(session.messages, session.compaction)
    const exchanges = buildTranscript(session.messages)
    const shown = exchanges.slice(-MAX_REPLAYED_EXCHANGES)
    this.omittedExchanges = exchanges.length - shown.length
    this.items = shown.flat()
    this.queue.length = 0
    this.internal = null
    this.sessionApprovals.clear()
    this.items.push({
      kind: 'notice',
      id: this.nextId(),
      variant: 'info',
      text: `Cabang ${shortId(session.id)} dibuat dari ${shortId(sourceId)}. Konteks percakapan disalin; file workspace tetap dipakai bersama dan riwayat /undo dimulai baru.`,
    })
    this.emit({ type: 'snapshot', snapshot: this.snapshot() })
  }

  /** Membuat cabang baru dari keadaan tepat sebelum prompt yang dipilih. */
  async rewindSession(requestedTurn?: number): Promise<void> {
    this.requireIdle()
    if (!this.recorder.started) throw new ControllerError('Belum ada percakapan untuk diputar balik. Kirim satu pesan terlebih dahulu.')
    const sourceId = this.recorder.id
    let source
    try {
      source = loadSession(sourceId)
    } catch (error) {
      throw new ControllerError(error instanceof Error ? error.message : 'Sesi tidak dapat dimuat.')
    }
    const turns = sessionTurns(source.messages)
    if (!turns.length) throw new ControllerError('Sesi ini belum memiliki prompt yang dapat dipilih.')

    let selected = requestedTurn === undefined
      ? undefined
      : turns.find((turn) => turn.number === requestedTurn)
    if (requestedTurn !== undefined && (!Number.isInteger(requestedTurn) || !selected)) {
      throw new ControllerError(`Prompt #${requestedTurn} tidak ditemukan. Pilih nomor 1 sampai ${turns.at(-1)?.number}.`)
    }
    if (!selected) {
      // Daftar dibatasi untuk menjaga kartu tetap ringan. Prompt lama tetap bisa
      // dipilih secara eksplisit dengan `/rewind <nomor>`.
      const recent = turns.slice(-20).reverse()
      const answer = await this.ask({
        title: 'Putar balik percakapan',
        subject: recent.length < turns.length ? `20 prompt terbaru dari ${turns.length}` : `${turns.length} prompt`,
        prompt: 'Buat cabang baru dari keadaan sebelum prompt mana?',
        body: { type: 'text', text: 'Sesi asal tetap utuh. File workspace tidak diubah dan riwayat /undo cabang dimulai baru.' },
        options: [
          ...recent.map((turn, index) => ({
            id: `turn-${turn.number}`,
            label: `#${turn.number} · ${turn.title}`,
            ...(index === 0 ? { tone: 'primary' as const } : {}),
          })),
          { id: 'cancel', label: 'Batal' },
        ],
      })
      if (answer.optionId === 'dismiss' || answer.optionId === 'cancel') return
      const number = Number(answer.optionId.slice('turn-'.length))
      selected = turns.find((turn) => turn.number === number)
      if (!selected) throw new ControllerError('Titik rewind tidak lagi berlaku.', 409)
    }

    let session
    try {
      session = forkSessionAt(sourceId, selected.messageIndex)
    } catch (error) {
      throw new ControllerError(error instanceof Error ? error.message : 'Sesi tidak dapat diputar balik.')
    }
    if (session.workspace !== this.workspace) throw new ControllerError('Sesi itu milik direktori lain.', 403)

    this.dismissQuestion()
    this.modelMode = session.modelMode ?? 'manual'
    if (session.model) {
      this.provider.model = session.model
      this.provider.reasoningEffort = acceptedEffort(session.model, session.reasoningEffort)
    }
    this.recorder = this.newRecorder(session.id)
    this.agent = this.createAgent(session.messages, session.compaction)
    const exchanges = buildTranscript(session.messages)
    const shown = exchanges.slice(-MAX_REPLAYED_EXCHANGES)
    this.omittedExchanges = exchanges.length - shown.length
    this.items = shown.flat()
    this.queue.length = 0
    this.internal = null
    this.sessionApprovals.clear()
    this.items.push({
      kind: 'notice',
      id: this.nextId(),
      variant: 'info',
      text: `Cabang ${shortId(session.id)} dibuat sebelum prompt #${selected.number}. Sesi asal ${shortId(sourceId)} tetap utuh. File workspace tidak diubah dan riwayat /undo dimulai baru.`,
    })
    this.emit({ type: 'snapshot', snapshot: this.snapshot() })
  }

  /* ------------------------------------------------------------ model */

  private modelView(): ModelView {
    const label = describeSelection(groupModels([this.provider.model]), this.provider.model, this.provider.reasoningEffort)
    return {
      mode: this.modelMode,
      id: this.provider.model,
      effort: this.provider.reasoningEffort ?? null,
      label: this.modelMode === 'auto' ? `Auto · ${this.agent.lastAutoSelection ? label : 'menunggu tugas'}` : `Manual · ${label}`,
    }
  }

  /**
   * Keadaan penyedia untuk halaman pengaturan. Yang dikirim hanya alamat dan
   * apakah kuncinya sudah ada — nilai kuncinya sendiri tidak pernah meninggalkan
   * proses ini, termasuk ke tab yang sedang terbuka.
   */
  providerStatus(): ProviderStatusView[] {
    const configured = profilesFromConfig(this.settings)
    const primary = defaultProfile(configured)
    return PROVIDER_DEFINITIONS.map((definition) => {
      const profile = configured.find((candidate) => candidate.id === definition.id)
      return {
        id: definition.id,
        label: definition.label,
        hint: definition.hint,
        keySource: definition.keySource,
        keyRequired: definition.keyRequired,
        baseUrl: profile?.baseUrl ?? (this.settings[definition.urlName] ?? '').trim() ?? definition.defaultBaseUrl,
        configured: Boolean(profile),
        hasKey: Boolean((this.settings[definition.keyName] ?? '').trim()),
        ...(definition.id === 'ninerouter' ? { hasDashboardPassword: Boolean((this.settings.NINEROUTER_DASHBOARD_PASSWORD ?? '').trim()) } : {}),
        primary: Boolean(profile) && primary?.id === definition.id,
      }
    })
  }

  /**
   * Menyimpan atau menghapus satu penyedia. Koneksinya diperiksa lebih dulu supaya
   * kunci yang salah ketik tidak tersimpan diam-diam, lalu setelan ditulis ke
   * ~/.boo/.env dengan izin hanya untuk pemilik.
   */
  async saveProvider(input: { id: string; baseUrl?: string; apiKey?: string; dashboardPassword?: string; remove?: boolean }): Promise<{ models: number }> {
    this.requireIdle()
    const definition = providerDefinition(input.id)
    if (!definition) throw new ControllerError(`Penyedia "${input.id}" tidak dikenal.`, 404)

    if (input.remove) {
      this.writeSettings({ [definition.urlName]: '', [definition.keyName]: '' })
      return { models: 0 }
    }

    const baseUrl = (input.baseUrl ?? '').trim() || (this.settings[definition.urlName] ?? '').trim() || definition.defaultBaseUrl
    if (!baseUrl) throw new ControllerError('Alamat API wajib diisi untuk penyedia ini.')
    try {
      const parsed = new URL(baseUrl)
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('protokol')
    } catch {
      throw new ControllerError(`"${baseUrl}" bukan alamat HTTP(S) yang sah.`)
    }

    const apiKey = (input.apiKey ?? '').trim() || (this.settings[definition.keyName] ?? '').trim()
    if (!apiKey && definition.keyRequired) throw new ControllerError(`Kunci API wajib diisi; ambil dari ${definition.keySource}.`)

    const profile: ProviderProfile = { id: definition.id, label: definition.label, baseUrl, apiKey, wire: definition.wire }
    let models: string[]
    try {
      models = profile.wire === 'anthropic'
        ? await listAnthropicModels(profile, 15_000)
        : await new NineRouterProvider({ baseUrl, apiKey, profiles: [profile], model: '', timeoutMs: 15_000 }).listModels()
    } catch (error) {
      throw new ControllerError(`Tidak dapat terhubung ke ${definition.label}: ${error instanceof Error ? error.message : 'error tak dikenal'}`, 502)
    }

    const dashboard = (input.dashboardPassword ?? '').trim()
    if (dashboard && definition.id === 'ninerouter') {
      // Diperiksa sekali saja: dashboard mengunci akun setelah beberapa kegagalan.
      try {
        await loginToDashboard(baseUrl, dashboard)
      } catch (error) {
        const attempts = error instanceof DashboardError && error.attemptsLeft !== undefined ? ` (sisa ${error.attemptsLeft} percobaan sebelum terkunci)` : ''
        throw new ControllerError(`${error instanceof Error ? error.message : 'Password dashboard ditolak'}${attempts}`, 502)
      }
    }

    this.writeSettings({
      [definition.urlName]: baseUrl,
      ...(apiKey ? { [definition.keyName]: apiKey } : {}),
      ...(dashboard && definition.id === 'ninerouter' ? { NINEROUTER_DASHBOARD_PASSWORD: dashboard } : {}),
    })
    return { models: models.length }
  }

  /** Menulis setelan, lalu menerapkannya ke penyedia yang sedang berjalan. */
  private writeSettings(values: Record<string, string>): void {
    updateEnvFile(this.options.configPath ?? GLOBAL_CONFIG_PATH, values)
    Object.assign(this.settings, values)
    this.provider.profiles = profilesFromConfig(this.settings)
    this.emit({ type: 'providers', providers: this.providerStatus() })
    this.emit({ type: 'model', model: this.modelView() })
  }

  /** Sisa limit dan pemakaian, digabung dari semua sumber yang tersedia. */
  async quota(): Promise<QuotaReportView> {
    const report = await gatherQuota({ profiles: profilesFromConfig(this.settings), config: this.settings })
    return {
      entries: report.entries.map((entry) => ({ ...entry, providerLabel: providerLabel(entry.providerId) })),
      usage: report.usage.map((usage) => ({
        model: usage.model,
        providerLabel: providerLabel(usage.providerId),
        requests: usage.requests,
        failures: usage.failures,
        tokens: usage.inputTokens + usage.outputTokens,
        ...(usage.cooldownUntil ? { cooldownUntil: usage.cooldownUntil } : {}),
      })),
      notes: report.notes,
    }
  }

  async models(): Promise<ModelFamilyView[]> {
    let ids: string[]
    try {
      ids = await this.provider.listModels()
    } catch (error) {
      throw new ControllerError(error instanceof Error ? error.message : 'Daftar model gagal dimuat.', 502)
    }
    const families = groupModels(ids)
    const current = findSelection(families, this.provider.model, this.provider.reasoningEffort)
    const rank = (key: string) => {
      const index = FEATURED_FAMILIES.indexOf(key)
      return index === -1 ? FEATURED_FAMILIES.length : index
    }
    return [...families]
      .sort((a, b) => rank(a.key) - rank(b.key))
      .map((family) => ({
        key: family.key,
        label: family.label,
        featured: FEATURED_FAMILIES.includes(family.key),
        options: family.options.map((option) => ({
          label: option.label,
          modelId: option.modelId,
          effort: option.reasoningEffort ?? null,
          current: this.modelMode === 'manual' && current?.option === option,
        })),
      }))
  }

  setModel(modelId: string, effort: string | null): void {
    this.requireIdle()
    if (!modelId) throw new ControllerError('Model wajib diisi.')
    if (modelId === 'auto') {
      if (effort) throw new ControllerError('Auto menentukan tingkat penalaran sendiri.')
      this.modelMode = 'auto'
      this.agent.setModelMode(this.modelMode)
      this.recorder.recordModelMode(this.modelMode)
      this.emit({ type: 'model', model: this.modelView() })
      return
    }
    const accepted = acceptedEffort(modelId, effort ?? undefined)
    if (effort && !accepted) throw new ControllerError(`Tingkat "${effort}" tidak berlaku untuk ${modelId}.`)
    this.modelMode = 'manual'
    this.agent.setModelMode(this.modelMode)
    this.recorder.recordModelMode(this.modelMode)
    this.provider.model = modelId
    this.provider.reasoningEffort = accepted
    this.recorder.recordModel(modelId, accepted)
    this.emit({ type: 'model', model: this.modelView() })
  }

  /* ------------------------------------------------------------ permintaan */

  /** Pesan dari kotak ketik: dijalankan, atau masuk antrean bila Boo sedang bekerja. */
  submit(text: string, images: ImageAttachment[] = []): void {
    const input = text.trim()
    try { validateImages(images) } catch (error) {
      throw new ControllerError(error instanceof Error ? error.message : 'Daftar attachment tidak sah.')
    }
    if (!input && !images.length) return
    for (const image of images) {
      if (!image.ref.startsWith(`${this.recorder.id}/`)) throw new ControllerError('Attachment bukan milik sesi aktif.')
      try { imageDataUrl(image, this.options.home ?? homedir()) } catch (error) {
        throw new ControllerError(error instanceof Error ? error.message : 'Attachment tidak sah.')
      }
    }
    // Teks biasa saat agent aktif adalah koreksi terhadap pekerjaan saat ini.
    // Command dan attachment tetap menjadi task tersendiri karena punya lifecycle lain.
    if (this.busy && !this.question && !images.length && !input.startsWith('/')) {
      try {
        const position = this.agent.steer(input)
        if (position) {
          this.putItem({ kind: 'user', id: this.nextId(), text: input, steering: true })
          this.notice('info', `Arahan tengah jalan diterima #${position}; diterapkan pada batas aman berikutnya.`)
          return
        }
      } catch (error) {
        throw new ControllerError(error instanceof Error ? error.message : 'Arahan tidak dapat diterima.')
      }
    }
    // Mengetik saat ada pertanyaan yang tidak terkait pekerjaan berarti melewatinya.
    if (!this.busy) this.dismissQuestion()
    this.queue.push({ text: input || 'Analisis gambar yang dilampirkan.', images })
    this.emitQueue()
    void this.processNext()
  }

  uploadImage(name: string, mediaType: string, data: Buffer): ImageAttachment {
    try {
      return storeImageData(data, {
        sessionId: this.recorder.id,
        home: this.options.home ?? homedir(),
        name,
        declaredMediaType: mediaType,
      })
    } catch (error) {
      throw new ControllerError(error instanceof Error ? error.message : 'Gambar tidak dapat disimpan.')
    }
  }

  clearQueue(): void {
    this.queue.length = 0
    this.emitQueue()
  }

  cancel(): void {
    if (this.abort && !this.abort.signal.aborted) {
      this.abort.abort()
      this.setStatus({ label: 'Stopping', detail: '', startedAt: Date.now() })
    }
    // Izin yang sedang ditanyakan dijawab "batal"; agent melihat sinyal dan berhenti.
    if (this.busy) this.dismissQuestion()
  }

  /**
   * Satu-satunya jalan permintaan dijalankan. Penjaga `processing` memastikan tidak
   * pernah ada dua permintaan berjalan bersamaan, walau dipicu dari banyak tempat:
   * kotak ketik, jawaban pertanyaan, dan langkah lanjutan mode spec.
   */
  private async processNext(): Promise<void> {
    if (this.processing) return
    this.processing = true
    try {
      while (!this.busy && !this.question) {
        let job = this.internal
        this.internal = null
        if (!job) {
          const queued = this.queue.shift()
          if (queued === undefined) break
          this.emitQueue()
          job = await this.jobFor(queued.text)
          if (!job) {
            if (queued.images.length) this.notice('error', 'Attachment dilepas karena perintah ini tidak mengirim prompt ke model.')
            continue
          }
          if (job.kind === 'send' && queued.images.length) job.images = queued.images
          else if (queued.images.length) this.notice('error', 'Attachment hanya dapat dipakai pada prompt untuk model.')
        }
        await this.run(job)
      }
    } finally {
      this.processing = false
    }
  }

  /** Perintah garis miring ditangani di sini; selain itu menjadi permintaan biasa. */
  private async jobFor(text: string): Promise<Job | null> {
    const command = text.split(/\s+/)[0]
    switch (command) {
      case '/compact':
        return { display: '/compact', prompt: '', kind: 'compact' }
      case '/review': {
        const base = text.slice('/review'.length).trim() || undefined
        try {
          return { display: base ? `/review ${base}` : '/review', prompt: reviewRequest(base), kind: 'send', mode: 'review' }
        } catch (error) {
          this.notice('error', error instanceof Error ? error.message : 'Base review tidak valid.')
          return null
        }
      }
      case '/plan': {
        const task = text.slice('/plan'.length).trim()
        if (!task) {
          this.notice('error', 'Tulis tugas setelah /plan.')
          return null
        }
        return { display: `/plan ${task}`, prompt: planRequest(task), kind: 'send', mode: 'plan' }
      }
      case '/implement': {
        const saved = latestPlan(this.agent.history)
        if (!saved) {
          this.notice('error', 'Belum ada rencana /plan yang selesai di sesi ini.')
          return null
        }
        return { display: '/implement', prompt: implementPlanRequest(saved), kind: 'send' }
      }
      case '/stats': {
        const stats = aggregateLocalTraces(this.options.home ?? homedir(), this.workspace, 100)
        const models = Object.entries(stats.models).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, count]) => `${name} ${count}×`).join(', ')
        this.notice('info', stats.runs
          ? `Metrik lokal ${stats.runs} run: ${stats.completed} selesai, ${stats.cancelled} dibatalkan, ${stats.errors} error. Rata-rata ${(stats.averageDurationMs / 1_000).toFixed(1)}s, ${stats.averageTurns} turn, ${stats.averageToolCalls} tool call. Kegagalan tool ${stats.toolFailureRate}%. Review otomatis ${stats.criticReviews}, temuan ${stats.criticFindings}, gagal ${stats.criticFailures}. Risiko tinggi ${stats.highRiskRuns}. Arahan live ${stats.steeringMessages}. Evidence cache ${stats.evidenceCacheHits} hit, ${stats.evidenceCacheSavedCharacters.toLocaleString('id-ID')} karakter dihemat. Context relevance mempertahankan ${stats.contextPrioritizedMessages} pesan lama. Parallel discovery ${stats.parallelDiscoveryCalls} call dalam ${stats.parallelDiscoveryBatches} batch. Tool result store menahan ${stats.deferredToolResultCharacters.toLocaleString('id-ID')} karakter dari ${stats.truncatedToolResults} hasil besar.${models ? ` Model: ${models}.` : ''}\n\nPrompt, kode, argumen, dan output tidak direkam.`
          : 'Belum ada trace lokal untuk workspace ini.')
        return null
      }
      case '/context': {
        const report = this.agent.contextReport()
        const number = (value: number) => value.toLocaleString('id-ID')
        const state = report.pressure === 'healthy' ? 'aman' : report.pressure === 'attention' ? 'perlu perhatian' : 'kritis'
        const details = [
          `Konteks model · ${state} · ${report.usagePercent}%`,
          `Dikirim ${number(report.sentTokens)} / ${number(report.limitTokens)} token; ruang ${number(report.headroomTokens)}.`,
          `System ${number(report.breakdown.system)} · pengguna ${number(report.breakdown.user)} · jawaban ${number(report.breakdown.assistant)} · hasil tool ${number(report.breakdown.toolResults)} · panggilan tool ${number(report.breakdown.toolCalls)} · skema tool ${number(report.breakdown.toolSchemas)} · gambar ${number(report.breakdown.images)}.`,
          `Riwayat ${report.historyMessages} pesan · konteks aktif ${report.messages} · dikirim ${report.sentMessages}.`,
          ...(report.compactionActive ? [`${report.summarizedMessages} pesan lama sudah diganti ringkasan otomatis.`] : []),
          ...(report.droppedMessages
            ? [`${report.droppedMessages} pesan tidak muat; ${report.prioritizedMessages} pesan lama relevan akan dipertahankan.`]
            : report.pressure !== 'healthy'
              ? ['Gunakan /compact bila ingin memberi ruang sebelum task besar berikutnya.']
              : ['Belum perlu compact; Boo akan meringkas otomatis saat mendekati batas.']),
        ]
        this.notice(report.pressure === 'critical' ? 'error' : 'info', details.join('\n'))
        return null
      }
      case '/status':
        this.notice('info', formatTaskStatus(await this.agent.taskStatus()))
        return null
      case '/init':
        return { display: '/init', prompt: INIT_PROMPT, kind: 'send' }
      case '/undo':
        await this.offerUndo()
        return null
      case '/restore': {
        const argument = text.slice('/restore'.length).trim()
        if (argument && !/^\d+$/.test(argument)) {
          this.notice('error', 'Pakai /restore atau /restore <id-checkpoint>.')
          return null
        }
        await this.offerRestore(argument ? Number(argument) : undefined)
        return null
      }
      case '/spec': {
        const idea = text.slice('/spec'.length).trim()
        if (idea) {
          const name = uniqueSpecName(this.workspace, idea)
          return this.specJob(name, requirementsPrompt(name, idea))
        }
        await this.offerSpecList()
        return null
      }
      case '/help':
        this.notice('info', 'Perintah: /plan <tugas>, /implement, /review [base], /spec <ide>, /spec, /undo, /restore [id], /fork, /rewind [nomor], /compact, /context, /status, /stats, /init, /commands, /hooks, /permissions, /apps, /open <alias>, /run <perintah>. Pakai @path atau @file:10-30 untuk menyertakan konteks workspace. Model, sesi, dan antrean ada di tombol halaman. Esc menghentikan pekerjaan.')
        return null
      case '/commands': {
        const commands = loadPromptCommands({ workspace: this.workspace, home: this.options.home ?? homedir() })
        this.notice(commands.length ? 'info' : 'error', commands.length
          ? commands.map((item) => `/${item.name} — ${item.description} [${item.source}]`).join('\n')
          : 'Belum ada custom command. Tambahkan .boo/commands/<nama>.md atau ~/.boo/commands/<nama>.md.')
        return null
      }
      case '/hooks': {
        const hooks = loadHooks(this.workspace, this.options.home ?? homedir())
        this.notice(hooks.length ? 'info' : 'error', hooks.length
          ? hooks.map((hook) => `${hook.event}:${hook.id} · ${hook.matcher} → ${hook.command} [${hook.source}]`).join('\n')
          : 'Belum ada lifecycle hook. Tambahkan .boo/hooks.json atau ~/.boo/hooks.json.')
        return null
      }
      case '/permissions': {
        const policy = loadPermissionPolicy({ workspace: this.workspace, home: this.options.home ?? homedir() })
        const rules = policy.rules.length ? policy.rules.map(permissionRuleLabel) : ['(belum ada aturan aktif)']
        const issues = policy.issues.map((issue) => `PERINGATAN: ${issue}`)
        this.notice('info', [
          'Aturan izin persisten:',
          ...rules.map((rule) => `- ${rule}`),
          ...issues.map((issue) => `- ${issue}`),
          '',
          `Pribadi (allow/ask/deny): ${policy.globalPath}`,
          `Proyek (ask/deny saja): ${policy.projectPath}`,
        ].join('\n'))
        return null
      }
      case '/apps':
        this.showApps()
        return null
      case '/open':
        await this.openRegisteredApp(text.slice('/open'.length).trim())
        return null
      case '/run':
        await this.runDirectCommand(text.slice('/run'.length).trim())
        return null
      case '/model':
        if (text === '/model auto') this.setModel('auto', null)
        else this.notice('info', '/model tersedia di tombol pemilih model; /model auto mengaktifkan pemilihan otomatis.')
        return null
      case '/resume':
      case '/queue':
        this.notice('info', `${command} tersedia sebagai tombol di halaman ini.`)
        return null
      case '/fork':
        this.forkSession()
        return null
      case '/rewind': {
        const argument = text.slice('/rewind'.length).trim()
        if (argument && !/^\d+$/.test(argument)) {
          this.notice('error', 'Pakai /rewind atau /rewind <nomor>.')
          return null
        }
        try {
          await this.rewindSession(argument ? Number(argument) : undefined)
        } catch (error) {
          this.notice('error', error instanceof Error ? error.message : 'Sesi tidak dapat diputar balik.')
        }
        return null
      }
      default: {
        try {
          const expanded = expandPromptCommand(text, loadPromptCommands({ workspace: this.workspace, home: this.options.home ?? homedir() }))
          return expanded ? { display: expanded.display, prompt: expanded.prompt, kind: 'send' } : { display: text, prompt: text, kind: 'send' }
        } catch (error) {
          this.notice('error', error instanceof Error ? error.message : 'Custom command gagal dimuat.')
          return null
        }
      }
    }
  }

  private showApps(): void {
    const catalog = loadApps(this.workspace)
    const list = catalog.apps.length
      ? catalog.apps.map((app) => `- ${app.id}: ${app.label}`).join('\n')
      : 'Belum ada aplikasi terdaftar.'
    const hint = 'Daftarkan alias pada ~/.boo/apps.json atau <workspace>/.boo/apps.json, lalu buka dengan /open <alias>.'
    this.notice(catalog.apps.length ? 'info' : 'error', [list, hint, ...catalog.issues].join('\n'))
  }

  private async openRegisteredApp(id: string): Promise<void> {
    if (!id) {
      this.notice('info', 'Pakai: /open <alias>. Lihat alias yang tersedia dengan /apps.')
      return
    }
    const app = findApp(loadApps(this.workspace), id)
    if (!app) {
      this.notice('error', `Aplikasi "${id}" tidak terdaftar. Jalankan /apps untuk melihat alias yang tersedia.`)
      return
    }
    const answer = await this.ask({
      title: 'Buka aplikasi',
      subject: app.label,
      prompt: `Buka aplikasi ${app.label}?`,
      options: [
        { id: 'allow', label: 'Ya', tone: 'primary' },
        { id: 'deny', label: 'Tidak', tone: 'danger' },
      ],
    })
    if (answer.optionId !== 'allow') {
      this.notice('info', `Membuka ${app.label} dibatalkan.`)
      return
    }
    try {
      await launchApp(app, this.workspace)
      this.notice('success', `${app.label} sedang dibuka.`)
    } catch (error) {
      this.notice('error', `Gagal membuka ${app.label}: ${error instanceof Error ? error.message : 'kesalahan tidak dikenal'}`)
    }
  }

  private async runDirectCommand(command: string): Promise<void> {
    if (!command) {
      this.notice('info', 'Pakai: /run <perintah>. Contoh: /run git status')
      return
    }
    const answer = await this.ask({
      title: 'Jalankan perintah',
      subject: '',
      prompt: 'Jalankan perintah ini?',
      body: { type: 'command', command, description: 'Dijalankan di folder workspace.' },
      options: [
        { id: 'allow', label: 'Ya', tone: 'primary' },
        { id: 'deny', label: 'Tidak', tone: 'danger' },
      ],
    })
    if (answer.optionId !== 'allow') {
      this.notice('info', 'Perintah dibatalkan.')
      return
    }
    this.setBusy(true)
    this.setStatus({ label: 'Running', detail: command, startedAt: Date.now() })
    const abort = new AbortController()
    this.abort = abort
    let result
    try {
      result = await runCommand(command, {
        cwd: this.workspace,
        shell: resolveShell(),
        sandbox: resolveSandboxPolicy(this.options.config.BOO_SANDBOX, this.options.config.BOO_NETWORK_ACCESS),
        timeoutMs: 120_000,
        signal: abort.signal,
      })
    } finally {
      this.abort = null
      this.setStatus(null)
      this.setBusy(false)
    }
    if (!result) return
    const message = result.cancelled
      ? 'Perintah dibatalkan.'
      : result.timedOut
        ? 'Waktu perintah habis setelah 120 detik.'
        : result.spawnError || result.exitCode !== 0
          ? `Perintah gagal: ${result.spawnError ?? `exit ${result.exitCode ?? '?'}`}`
          : 'Perintah selesai.'
    this.notice(result.cancelled || result.timedOut || result.spawnError || result.exitCode !== 0 ? 'error' : 'success', result.output ? `${message}\n\n${result.output}` : message)
  }

  private async run(job: Job): Promise<void> {
    this.setBusy(true)
    const spec = specPromptTitle(job.prompt)
    this.putItem({
      kind: 'user', id: this.nextId(), text: job.display,
      ...(spec === null ? {} : { spec }),
      ...(job.images?.length ? { attachments: job.images.map((image) => image.name) } : {}),
    })
    const presenter = new RequestPresenter({
      putItem: (item, toEnd) => this.putItem(item, toEnd),
      appendText: (id, text) => this.appendText(id, text),
      setStatus: (status) => this.setStatus(status),
      isLastItem: (id) => this.items.at(-1)?.id === id,
      nextId: () => this.nextId(),
    })
    this.presenter = presenter
    const abort = new AbortController()
    this.abort = abort
    let outcome: 'done' | 'stopped' = 'done'
    let compactionReported = false
    const wasStarted = this.recorder.started

    try {
      const rawEvents: AsyncGenerator<AgentEvent> = job.kind === 'compact'
        ? this.agent.compact({ signal: abort.signal })
        : this.agent.send(job.prompt, { signal: abort.signal, ...(job.mode ? { mode: job.mode } : {}), ...(job.images?.length ? { images: job.images } : {}) })
      const trace = new LocalRunTrace({
        home: this.options.home ?? homedir(), workspace: this.workspace, surface: 'web', kind: job.kind,
        mode: this.modelMode, model: this.provider.model, reasoningEffort: this.provider.reasoningEffort,
        requestCharacters: job.kind === 'compact' ? 0 : job.prompt.length,
        enabled: tracingEnabled(this.options.config.BOO_TRACE),
      })
      const journal = new PersistentRunJournal({
        home: this.options.home ?? homedir(), workspace: this.workspace,
        sessionId: this.recorder.id, surface: 'web', kind: job.kind, model: this.provider.model,
        ...(this.provider.reasoningEffort ? { reasoningEffort: this.provider.reasoningEffort } : {}),
      })
      const events = journalAgentEvents(traceAgentEvents(rawEvents, trace), journal)
      for await (const event of events) {
        if (event.type === 'model-selected') {
          this.recorder.recordModel(event.model, event.reasoningEffort)
          this.emit({ type: 'model', model: this.modelView() })
        }
        if (event.type === 'cancelled' || event.type === 'error' || event.type === 'turn-limit' || event.type === 'tool-loop' && event.stage === 'stopped') outcome = 'stopped'
        if (event.type === 'compacted' || event.type === 'compaction-failed') compactionReported = true
        presenter.handle(event)
      }
      if (job.kind === 'compact' && !compactionReported && outcome === 'done') {
        this.notice('info', 'Belum ada percakapan baru untuk diringkas.')
      }
    } catch (error) {
      outcome = 'stopped'
      presenter.handle({ type: 'error', message: error instanceof Error ? error.message : 'Terjadi kesalahan.' })
    } finally {
      presenter.finish()
      this.presenter = null
      this.abort = null
      this.setBusy(false)
    }
    if (!wasStarted && this.recorder.started) this.emit({ type: 'session', sessionId: this.recorder.id })
    if (job.after && outcome === 'done') await job.after()
  }

  /* ------------------------------------------------------------ pertanyaan */

  private ask(view: Omit<QuestionView, 'id'>): Promise<{ optionId: string; text: string }> {
    this.dismissQuestion()
    return new Promise((resolve) => {
      const question: PendingQuestion = { view: { ...view, id: this.nextId() }, resolve }
      this.question = question
      this.emit({ type: 'question', question: question.view })
    })
  }

  /** Menjawab pertanyaan dari halaman; false bila pertanyaannya sudah tidak berlaku. */
  answer(questionId: string, optionId: string, text = ''): boolean {
    const question = this.question
    if (!question || question.view.id !== questionId) return false
    const option = question.view.options.find((candidate) => candidate.id === optionId)
    if (!option) throw new ControllerError('Pilihan tidak dikenal.')
    if (option.input?.required && !text.trim()) throw new ControllerError('Pilihan ini memerlukan isian.')
    this.question = null
    this.emit({ type: 'question', question: null })
    question.resolve({ optionId, text: text.trim() })
    // Pertanyaan di luar pekerjaan (spec, undo) dapat menahan antrean.
    if (!this.busy) void this.processNext()
    return true
  }

  private dismissQuestion(): void {
    const question = this.question
    if (!question) return
    this.question = null
    this.emit({ type: 'question', question: null })
    question.resolve({ optionId: 'dismiss', text: '' })
  }

  /** Pertanyaan requirement berbeda dari approval: jawabannya kembali sebagai hasil tool. */
  private async askUser(question: UserQuestion): Promise<UserAnswer> {
    this.presenter?.commitPhase()
    this.setStatus(null)
    const answer = await this.ask({
      title: question.header || 'Pertanyaan Boo',
      subject: '',
      prompt: question.question,
      options: [
        ...question.options.map((option, index) => ({
          id: `choice-${index}`,
          label: option.description ? `${option.label} — ${option.description}` : option.label,
          tone: index === 0 ? 'primary' as const : undefined,
        })),
        ...(question.allowCustom ? [{
          id: 'custom',
          label: 'Jawaban lain',
          input: { placeholder: 'Tulis jawaban kamu', required: true },
        }] : []),
      ],
    })
    if (answer.optionId === 'custom' && answer.text) {
      this.presenter?.decision(true, `Jawaban · ${question.header ? `${question.header}: ` : ''}${answer.text}`)
      return { text: answer.text }
    }
    const match = /^choice-(\d+)$/.exec(answer.optionId)
    const selected = match ? question.options[Number(match[1])]?.label : undefined
    if (selected) {
      this.presenter?.decision(true, `Jawaban · ${question.header ? `${question.header}: ` : ''}${selected}`)
      return { selected }
    }
    return { cancelled: true }
  }

  private async askPermission({ name, args, detail, allowAlways, promptInjectionRisk }: { name: string; args: Record<string, unknown>; detail: DiffLine[] | null; allowAlways: boolean; promptInjectionRisk?: boolean }): Promise<boolean | PermissionDecision> {
    let fileExists = false
    try {
      fileExists = typeof args.path === 'string' && existsSync(resolveInWorkspace(this.workspace, args.path))
    } catch {
      // Path di luar workspace: tool akan menolaknya.
    }
    const request = describeRequest(name, args, fileExists)
    const command = typeof args.command === 'string' ? args.command : ''
    const appId = typeof args.id === 'string' ? args.id : ''
    const key = request.kind === 'edit'
      ? 'edit'
      : request.kind === 'command'
        ? `command:${command}`
        : name === 'open_app'
          ? `app:${appId}`
          : `tool:${name}`
    const summary = request.kind === 'command'
      ? `${request.title} · ${command}`
      : request.subject ? `${request.title} ${request.subject}` : request.title

    const home = this.options.home ?? homedir()
    const configured = evaluatePermission(loadPermissionPolicy({ workspace: this.workspace, home }), { tool: name, args })
    if (configured?.effect === 'deny') {
      this.presenter?.decision(false, `${summary} · ditolak oleh ${configured.rule.id} [${configured.rule.source}]`)
      return { allowed: false, feedback: `Aturan izin ${configured.rule.id} menolak tindakan ini.` }
    }
    const sandbox = inspectSandbox(
      this.workspace,
      resolveSandboxPolicy(this.options.config.BOO_SANDBOX, this.options.config.BOO_NETWORK_ACCESS),
    )
    const configuredEffect = resolveConfiguredPermission(configured, {
      allowAlways,
      commandAction: request.kind === 'command',
      sandbox,
    })
    if (configuredEffect === 'allow') {
      this.presenter?.decision(true, `${summary} · diizinkan oleh ${configured!.rule.id} [${configured!.rule.source}]`)
      return true
    }
    const forceAsk = configuredEffect === 'ask'

    if (!forceAsk && allowAlways && this.sessionApprovals.has(key)) {
      this.presenter?.decision(true, `${summary} · diizinkan otomatis di sesi ini`)
      return true
    }

    let body: QuestionBody | undefined
    if (request.kind === 'command') {
      body = { type: 'command', command, description: request.subject }
    } else if (detail?.length) {
      const condensed = condense(detail)
      const stats = diffStats(detail)
      body = {
        type: 'diff',
        path: request.subject,
        language: languageOf(request.subject),
        added: stats.added,
        removed: stats.removed,
        rows: condensed.slice(0, MAX_DIFF_ROWS).map(toDiffRow),
        truncated: Math.max(0, condensed.length - MAX_DIFF_ROWS),
      }
    }

    const answer = await this.ask({
      title: request.title,
      subject: request.kind === 'command' ? request.subject : request.subject,
      prompt: promptInjectionRisk
        ? `Sinyal prompt injection aktif. Periksa tindakan ini secara mandiri dan izinkan hanya jika sesuai permintaanmu.\n\n${request.question}`
        : request.question,
      ...(body ? { body } : {}),
      options: [
        { id: 'allow', label: 'Ya', tone: 'primary' },
        ...(allowAlways ? [{ id: 'always', label: request.allowAlways }] : []),
        { id: 'deny', label: 'Tidak', tone: 'danger', input: { placeholder: 'Beri tahu Boo apa yang harus dilakukan (opsional)', required: false } },
      ],
    })

    switch (answer.optionId) {
      case 'allow':
        this.presenter?.decision(true, `${summary} · diizinkan`)
        return true
      case 'always': {
        this.sessionApprovals.add(key)
        const scope = request.kind === 'edit' ? 'semua perubahan berkas' : request.kind === 'command' ? 'perintah ini' : name
        this.presenter?.decision(true, `${summary} · ${scope} diizinkan untuk sisa sesi`)
        return true
      }
      case 'deny':
        this.presenter?.decision(false, answer.text ? `${summary} · ditolak: ${answer.text}` : `${summary} · ditolak`)
        return { allowed: false, ...(answer.text ? { feedback: answer.text } : {}) }
      default:
        // Ditutup karena pekerjaan dihentikan.
        return { allowed: false }
    }
  }

  private async askTurnLimit(turns: number): Promise<boolean> {
    this.presenter?.commitPhase()
    this.setStatus(null)
    const answer = await this.ask({
      title: 'Batas langkah',
      subject: '',
      prompt: `Boo sudah ${turns} langkah mengerjakan permintaan ini. Lanjutkan?`,
      options: [
        { id: 'continue', label: 'Ya, lanjutkan', tone: 'primary' },
        { id: 'stop', label: 'Tidak, berhenti di sini' },
      ],
    })
    const proceed = answer.optionId === 'continue'
    this.presenter?.decision(proceed, proceed ? `lanjut setelah ${turns} langkah` : `berhenti setelah ${turns} langkah`)
    return proceed
  }

  /* ------------------------------------------------------------ /undo */

  private async offerUndo(): Promise<void> {
    const plan = await this.agent.checkpoints.plan()
    if (!plan) {
      this.notice('info', 'Belum ada perubahan berkas oleh Boo di sesi ini yang bisa dibatalkan.')
      return
    }
    if (!plan.entries.length) {
      await this.agent.undo()
      this.notice('info', 'Berkasnya sudah sama dengan sebelum permintaan itu; tidak ada yang perlu dikembalikan.')
      return
    }
    const answer = await this.ask({
      title: 'Batalkan perubahan',
      subject: plan.prompt.replace(/\s+/g, ' ').slice(0, 120),
      prompt: `Kembalikan ${plan.entries.length} berkas?`,
      body: { type: 'undo', entries: plan.entries, ranCommands: plan.ranCommands },
      options: [
        { id: 'undo', label: 'Ya, kembalikan', tone: 'danger' },
        { id: 'keep', label: 'Tidak' },
      ],
    })
    if (answer.optionId !== 'undo') return
    if (this.busy) {
      this.notice('info', 'Boo sedang bekerja; /undo tidak dijalankan.')
      return
    }
    const done = await this.agent.undo()
    const restored = done?.entries.filter((entry) => entry.action === 'restore').length ?? 0
    const deleted = done?.entries.filter((entry) => entry.action === 'delete').length ?? 0
    const parts = [restored ? `${restored} berkas dikembalikan` : '', deleted ? `${deleted} berkas baru dihapus` : ''].filter(Boolean)
    this.notice('undo', `${parts.join(', ')}. Boo diberi tahu di permintaan berikutnya.`)
  }

  private async offerRestore(requestedId?: number): Promise<void> {
    const points = this.agent.checkpoints.restorePoints()
    if (!points.length) {
      this.notice('info', 'Belum ada checkpoint perubahan file di sesi ini.')
      return
    }
    let selected = requestedId === undefined
      ? undefined
      : points.find((point) => point.checkpointId === requestedId)
    if (requestedId !== undefined && !selected) {
      this.notice('error', `Checkpoint #${requestedId} tidak ditemukan di sesi ini.`)
      return
    }
    if (!selected) {
      const recent = points.slice(0, 20)
      const answer = await this.ask({
        title: 'Pulihkan workspace',
        subject: recent.length < points.length ? `20 checkpoint terbaru dari ${points.length}` : `${points.length} checkpoint`,
        prompt: 'Kembali ke keadaan sebelum checkpoint mana?',
        body: { type: 'text', text: 'Checkpoint terpilih dan seluruh perubahan file sesudahnya akan dikembalikan. Riwayat percakapan dan perubahan dari command tidak ikut diputar balik.' },
        options: [
          ...recent.map((point) => ({
            id: `checkpoint-${point.checkpointId}`,
            label: `#${point.checkpointId} · ${point.prompt.replace(/\s+/g, ' ').slice(0, 80)}${point.ranCommands ? ' · ada command' : ''}`,
          })),
          { id: 'cancel', label: 'Batal' },
        ],
      })
      if (answer.optionId === 'dismiss' || answer.optionId === 'cancel') return
      const id = Number(answer.optionId.slice('checkpoint-'.length))
      selected = points.find((point) => point.checkpointId === id)
      if (!selected) {
        this.notice('error', 'Checkpoint tidak lagi tersedia.')
        return
      }
    }

    let plan
    try {
      plan = await this.agent.checkpoints.planRestore(selected.checkpointId)
    } catch (error) {
      this.notice('error', error instanceof Error ? error.message : 'Checkpoint tidak dapat ditinjau.')
      return
    }
    if (!plan) {
      this.notice('error', 'Checkpoint tidak lagi tersedia.')
      return
    }
    const answer = await this.ask({
      title: 'Konfirmasi restore workspace',
      subject: `checkpoint #${plan.checkpointId} · ${plan.prompt.replace(/\s+/g, ' ').slice(0, 100)}`,
      prompt: `Kembalikan ${plan.entries.length} file melewati ${plan.checkpointCount} checkpoint?`,
      body: { type: 'undo', entries: plan.entries, ranCommands: plan.ranCommands },
      options: [
        { id: 'restore', label: 'Ya, pulihkan workspace', tone: 'danger' },
        { id: 'keep', label: 'Tidak' },
      ],
    })
    if (answer.optionId !== 'restore') return
    if (this.busy) {
      this.notice('info', 'Boo sedang bekerja; restore tidak dijalankan.')
      return
    }
    try {
      const done = await this.agent.restore(plan.checkpointId, plan.fingerprint)
      const restored = done?.entries.filter((entry) => entry.action === 'restore').length ?? 0
      const deleted = done?.entries.filter((entry) => entry.action === 'delete').length ?? 0
      const parts = [restored ? `${restored} file dikembalikan` : '', deleted ? `${deleted} file baru dihapus` : ''].filter(Boolean)
      this.notice('undo', `${parts.join(', ') || 'Workspace sudah berada pada keadaan target'}. ${plan.checkpointCount} checkpoint dilepas; percakapan tetap utuh.`)
    } catch (error) {
      this.notice('error', error instanceof Error ? error.message : 'Restore gagal.')
    }
  }

  /* ------------------------------------------------------------ mode spec */

  specs(): SpecView[] {
    return listSpecs(this.workspace).map((spec) => ({
      name: spec.name,
      stage: spec.stage,
      done: spec.tasks.filter((task) => task.done).length,
      total: spec.tasks.length,
    }))
  }

  /** Membuka alur spec yang sudah ada dari daftar di halaman. */
  openSpec(name: string): void {
    this.requireIdle()
    if (!readSpec(this.workspace, name)) throw new ControllerError(`Spec "${name}" tidak ditemukan.`, 404)
    void this.offerSpecStep(name)
  }

  private specJob(name: string, prompt: string, after: () => Promise<void> = () => this.offerSpecStep(name)): Job {
    return { display: `/spec · ${specPromptTitle(prompt) ?? name}`, prompt, kind: 'send', after }
  }

  private queueInternal(job: Job): void {
    this.internal = job
    void this.processNext()
  }

  private async offerSpecList(): Promise<void> {
    const specs = this.specs()
    if (!specs.length) {
      this.notice('info', `Belum ada spec di ${SPECS_DIRECTORY}. Mulai dengan: /spec <ide fitur>, misal /spec login dengan Google`)
      return
    }
    const answer = await this.ask({
      title: 'Spec',
      subject: SPECS_DIRECTORY,
      prompt: 'Spec mana yang ingin dilanjutkan?',
      options: specs.map((spec) => ({ id: spec.name, label: `${spec.name} · ${describeStage(spec)}` })),
    })
    if (specs.some((spec) => spec.name === answer.optionId)) await this.offerSpecStep(answer.optionId)
  }

  private async offerSpecStep(name: string): Promise<void> {
    const spec = readSpec(this.workspace, name)
    const where = `${SPECS_DIRECTORY}/${name}`
    if (!spec || spec.stage === 'requirements') {
      this.notice('info', `${where}/requirements.md belum ditulis. Mulai ulang dengan /spec <ide fitur>.`)
      return
    }
    if (spec.stage === 'done') {
      this.notice('success', `Semua ${spec.tasks.length} tugas spec ${name} selesai.`)
      return
    }

    const reviseOption = (document: SpecDocument): QuestionOption => ({
      id: 'revise',
      label: `Revisi ${document}`,
      input: { placeholder: `Arahan revisi untuk ${document}`, required: true },
    })
    const stop: QuestionOption = { id: 'stop', label: 'Berhenti dulu' }

    if (spec.stage === 'design' || spec.stage === 'tasks') {
      const [ready, next, prompt] = spec.stage === 'design'
        ? ['requirements.md', 'design', designPrompt(name)] as const
        : ['design.md', 'tasks', tasksPrompt(name)] as const
      const answer = await this.ask({
        title: 'Spec',
        subject: `${where}/${ready}`,
        prompt: `${ready} siap ditinjau. Buka berkasnya, lalu pilih langkah berikutnya.`,
        options: [{ id: 'next', label: `Setujui dan lanjut ke ${next}`, tone: 'primary' }, reviseOption(ready), stop],
      })
      if (answer.optionId === 'next') this.queueInternal(this.specJob(name, prompt))
      else if (answer.optionId === 'revise') this.queueInternal(this.specJob(name, revisePrompt(name, ready, answer.text)))
      return
    }

    const task = nextTask(spec) as SpecTask
    const done = spec.tasks.filter((item) => item.done).length
    const answer = await this.ask({
      title: 'Spec',
      subject: `${where}/tasks.md`,
      prompt: `${done}/${spec.tasks.length} tugas selesai. Berikutnya: ${task.number}. ${task.title}`,
      options: [
        { id: 'one', label: 'Kerjakan tugas berikutnya', tone: 'primary' },
        { id: 'all', label: 'Kerjakan semua tugas yang tersisa' },
        reviseOption('tasks.md'),
        stop,
      ],
    })
    if (answer.optionId === 'one' || answer.optionId === 'all') {
      const all = answer.optionId === 'all'
      this.queueInternal(this.specJob(name, taskPrompt(name, task), () => this.afterSpecTask(name, task, all)))
    } else if (answer.optionId === 'revise') {
      this.queueInternal(this.specJob(name, revisePrompt(name, 'tasks.md', answer.text)))
    }
  }

  private async afterSpecTask(name: string, task: SpecTask, all: boolean): Promise<void> {
    const spec = readSpec(this.workspace, name)
    const updated = spec?.tasks.find((item) => item.number === task.number)
    if (!spec || !updated?.done) {
      this.notice('info', `Tugas ${task.number} belum dicentang di tasks.md, jadi dianggap belum selesai.`)
      if (spec) await this.offerSpecStep(name)
      return
    }
    const next = nextTask(spec)
    if (all && next) {
      this.notice('success', `Tugas ${task.number} selesai · lanjut ke tugas ${next.number}`)
      this.queueInternal(this.specJob(name, taskPrompt(name, next), () => this.afterSpecTask(name, next, true)))
      return
    }
    await this.offerSpecStep(name)
  }

  /* ------------------------------------------------------------ lain-lain */

  private requireIdle(): void {
    if (this.busy) throw new ControllerError('Boo sedang bekerja. Hentikan dulu atau tunggu sampai selesai.', 409)
  }

  /** Dipanggil saat server ditutup. */
  close(): void {
    this.cancel()
    this.dismissQuestion()
    backgroundProcesses.killAll()
    this.listeners.clear()
  }
}

function toDiffRow(line: DiffLine): DiffRow {
  if (line.skipped) return { kind: 'skip', text: '', skipped: line.skipped }
  return {
    kind: line.kind,
    text: line.text,
    ...(line.oldNumber !== undefined ? { oldNumber: line.oldNumber } : {}),
    ...(line.newNumber !== undefined ? { newNumber: line.newNumber } : {}),
  }
}

function describeStage(spec: SpecView): string {
  switch (spec.stage) {
    case 'requirements': return 'belum ada requirements'
    case 'design': return 'requirements siap · berikutnya design'
    case 'tasks': return 'design siap · berikutnya tasks'
    case 'implementing': return `tugas ${spec.done}/${spec.total} selesai`
    case 'done': return `selesai · ${spec.total} tugas`
  }
}
