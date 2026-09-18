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
  Agent,
  backgroundProcesses,
  condense,
  createDefaultRegistry,
  describeSelection,
  designPrompt,
  diffStats,
  FEATURED_FAMILIES,
  findSelection,
  groupModels,
  INIT_PROMPT,
  listSpecs,
  loadInstructions,
  NineRouterProvider,
  nextTask,
  readSpec,
  requirementsPrompt,
  resolveInWorkspace,
  revisePrompt,
  specPromptTitle,
  SPECS_DIRECTORY,
  taskPrompt,
  tasksPrompt,
  uniqueSpecName,
  type AgentEvent,
  type Compaction,
  type DiffLine,
  type Message,
  type PermissionDecision,
  type ProviderOptions,
  type SpecDocument,
  type SpecTask,
} from '@boo/core'
import type { BooKey } from '@boo/core/config/config.ts'
import { describeRequest, languageOf } from '@boo/core/presentation/approval.ts'
import { buildTranscript } from '@boo/core/presentation/transcript.ts'
import type { ViewItem } from '@boo/core/presentation/view.ts'
import { listSessions, loadSession, SessionRecorder } from '@boo/core/session/sessions.ts'
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
}

interface Job {
  /** Yang tampil sebagai pertanyaan pengguna. */
  display: string
  prompt: string
  kind: 'send' | 'compact'
  /** Dijalankan hanya bila permintaan selesai normal. */
  after?: () => Promise<void>
}

interface PendingQuestion {
  view: QuestionView
  resolve: (answer: { optionId: string; text: string }) => void
}

type Listener = (event: ServerEvent) => void

export class WebController {
  private readonly options: ControllerOptions
  private readonly workspace: string
  private readonly provider: NineRouterProvider
  private recorder: SessionRecorder
  private agent: Agent
  private items: ViewItem[] = []
  private omittedExchanges = 0
  private busy = false
  private abort: AbortController | null = null
  private presenter: RequestPresenter | null = null
  private readonly queue: string[] = []
  private internal: Job | null = null
  private status: StatusView | null = null
  private question: PendingQuestion | null = null
  private readonly sessionApprovals = new Set<string>()
  private readonly listeners = new Set<Listener>()
  private counter = 0
  private processing = false

  constructor(options: ControllerOptions) {
    this.options = options
    this.workspace = options.workspace
    const model = options.config.BOO_MODEL || DEFAULT_MODEL
    const providerOptions: ProviderOptions = {
      baseUrl: options.config.NINEROUTER_URL || DEFAULT_BASE_URL,
      apiKey: options.config.NINEROUTER_KEY ?? '',
      model,
      reasoningEffort: acceptedEffort(model, options.config.BOO_EFFORT),
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
      queue: [...this.queue],
      status: this.status,
      question: this.question?.view ?? null,
      instructions: this.agent.instructions.map((file) => file.label),
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
    this.emit({ type: 'queue', queue: [...this.queue] })
  }

  /* ------------------------------------------------------------ agent dan sesi */

  private newRecorder(resumeId?: string): SessionRecorder {
    return new SessionRecorder({
      workspace: this.workspace,
      model: this.provider.model,
      ...(this.provider.reasoningEffort ? { reasoningEffort: this.provider.reasoningEffort } : {}),
      ...(resumeId ? { resumeId } : {}),
    })
  }

  private createAgent(history?: Message[], compaction?: Compaction): Agent {
    const recorder = () => this.recorder
    return new Agent({
      provider: this.provider,
      registry: createDefaultRegistry(),
      workspace: this.workspace,
      instructions: () => loadInstructions({ workspace: this.workspace, home: this.options.home ?? homedir() }),
      ...(Number(this.options.config.BOO_MAX_TURNS) > 0 ? { maxTurns: Number(this.options.config.BOO_MAX_TURNS) } : {}),
      ...(this.options.config.BOO_MAX_CONTEXT_TOKENS ? { maxContextTokens: Number(this.options.config.BOO_MAX_CONTEXT_TOKENS) } : {}),
      ...(this.options.retryDelaysMs ? { retryDelaysMs: this.options.retryDelaysMs } : {}),
      ...(history ? { history } : {}),
      ...(compaction ? { compaction } : {}),
      onMessage: (message) => recorder().recordMessage(message),
      onCompaction: (summary) => recorder().recordCompaction(summary),
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
    this.emit({ type: 'snapshot', snapshot: this.snapshot() })
  }

  /* ------------------------------------------------------------ model */

  private modelView(): ModelView {
    return {
      id: this.provider.model,
      effort: this.provider.reasoningEffort ?? null,
      label: describeSelection(groupModels([this.provider.model]), this.provider.model, this.provider.reasoningEffort),
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
          current: current?.option === option,
        })),
      }))
  }

  setModel(modelId: string, effort: string | null): void {
    if (!modelId) throw new ControllerError('Model wajib diisi.')
    const accepted = acceptedEffort(modelId, effort ?? undefined)
    if (effort && !accepted) throw new ControllerError(`Tingkat "${effort}" tidak berlaku untuk ${modelId}.`)
    this.provider.model = modelId
    this.provider.reasoningEffort = accepted
    this.recorder.recordModel(modelId, accepted)
    this.emit({ type: 'model', model: this.modelView() })
  }

  /* ------------------------------------------------------------ permintaan */

  /** Pesan dari kotak ketik: dijalankan, atau masuk antrean bila Boo sedang bekerja. */
  submit(text: string): void {
    const input = text.trim()
    if (!input) return
    // Mengetik saat ada pertanyaan yang tidak terkait pekerjaan berarti melewatinya.
    if (!this.busy) this.dismissQuestion()
    this.queue.push(input)
    this.emitQueue()
    void this.processNext()
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
          const text = this.queue.shift()
          if (text === undefined) break
          this.emitQueue()
          job = await this.jobFor(text)
          if (!job) continue
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
      case '/init':
        return { display: '/init', prompt: INIT_PROMPT, kind: 'send' }
      case '/undo':
        await this.offerUndo()
        return null
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
        this.notice('info', 'Perintah: /spec <ide>, /spec, /undo, /compact, /init. Model, sesi, dan antrean ada di tombol halaman. Esc menghentikan pekerjaan.')
        return null
      case '/model':
      case '/resume':
      case '/queue':
        this.notice('info', `${command} tersedia sebagai tombol di halaman ini.`)
        return null
      default:
        return { display: text, prompt: text, kind: 'send' }
    }
  }

  private async run(job: Job): Promise<void> {
    this.setBusy(true)
    const spec = specPromptTitle(job.prompt)
    this.putItem({ kind: 'user', id: this.nextId(), text: job.display, ...(spec === null ? {} : { spec }) })
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
      const events: AsyncGenerator<AgentEvent> = job.kind === 'compact'
        ? this.agent.compact({ signal: abort.signal })
        : this.agent.send(job.prompt, { signal: abort.signal })
      for await (const event of events) {
        if (event.type === 'cancelled' || event.type === 'error' || event.type === 'turn-limit') outcome = 'stopped'
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

  private async askPermission({ name, args, detail }: { name: string; args: Record<string, unknown>; detail: DiffLine[] | null }): Promise<boolean | PermissionDecision> {
    let fileExists = false
    try {
      fileExists = typeof args.path === 'string' && existsSync(resolveInWorkspace(this.workspace, args.path))
    } catch {
      // Path di luar workspace: tool akan menolaknya.
    }
    const request = describeRequest(name, args, fileExists)
    const command = typeof args.command === 'string' ? args.command : ''
    const key = request.kind === 'edit' ? 'edit' : request.kind === 'command' ? `command:${command}` : `tool:${name}`
    const summary = request.kind === 'command'
      ? `${request.title} · ${command}`
      : request.subject ? `${request.title} ${request.subject}` : request.title

    if (this.sessionApprovals.has(key)) {
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
      prompt: request.question,
      ...(body ? { body } : {}),
      options: [
        { id: 'allow', label: 'Ya', tone: 'primary' },
        { id: 'always', label: request.allowAlways },
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
