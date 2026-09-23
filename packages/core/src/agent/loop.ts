/**
 * Agent loop: kirim percakapan, jalankan tool yang diminta, ulangi sampai model
 * berhenti meminta tool. Lapisan ini tidak tahu apa pun soal terminal maupun
 * browser — seluruh keluarannya berupa event, dan izin dimintakan lewat
 * callback. Itulah yang membuatnya bisa dipakai ulang oleh CLI dan web nanti.
 */

import type { ImageAttachment, Message, ToolCall, ToolSchema } from '../domain/message.ts'
import type { DiffLine } from '../tools/diff.ts'
import type { DelegatedResult, DelegatedTask, Tool, ToolRecovery, ToolRegistry, UserAsker } from '../domain/tool.ts'
import { ProviderError, type NineRouterProvider } from '../provider/nineRouter.ts'
import {
  alignCut,
  applyCompaction,
  chooseCut,
  COMPACT_THRESHOLD,
  renderForSummary,
  summaryRequest,
  type Compaction,
} from './compaction.ts'
import { DEFAULT_MAX_CONTEXT_TOKENS, estimateMessageTokens, estimateToolSchemaTokens, inspectContext, messageContextBudget, trimToBudget, type ContextReport } from './context.ts'
import { repairHistory, type RepairResult } from './history.ts'
import { Checkpoints, restoreNote, undoNote, type RestorePlan, type UndoPlan } from './checkpoints.ts'
import { composeSystemPrompt, instructionTargetsForTool, instructionsSignature, loadInstructions, SCOPED_INSTRUCTIONS_TOOL_RESULT, type InstructionFile } from './instructions.ts'
import { BOO_SYSTEM_PROMPT } from './prompt.ts'
import { assessLocally, AutoModelRouter, selectAutoModel, type AutoSelection, type ModelMode } from '../provider/auto.ts'
import { classifyProviderCapabilityError, type ProviderRequirements } from '../provider/capabilities.ts'
import { hasSubstantiveVerification, isVerificationCommand, riskVerificationPrompt, verificationPrompt, verificationStrength, type VerificationAttempt } from './verification.ts'
import { MAX_VERIFICATION_REPAIR_ROUNDS, VerificationRepairLoop } from './verificationRepair.ts'
import type { SandboxPolicy } from '../tools/sandbox.ts'
import { fileFreshnessPrompt, FileSnapshots, MAX_FRESHNESS_NOTICE_FILES, type ObservedFileChange } from '../tools/fileSnapshots.ts'
import { skillsSignature, type SkillDefinition } from '../tools/skills.ts'
import { createSubagentRegistry, createWritableSubagentRegistry, SUBAGENT_SYSTEM_PROMPT, WRITABLE_SUBAGENT_SYSTEM_PROMPT } from '../tools/delegate.ts'
import { automaticReviewRequest, AUTO_REVIEW_SYSTEM_PROMPT, criticFeedback, createReviewRegistry, MAX_AUTO_REVIEW_ROUNDS, parseCriticResult, REVIEW_SYSTEM_PROMPT, type CriticResult } from './review.ts'
import { PLAN_SYSTEM_PROMPT } from './planning.ts'
import { loadProjectMemories, memoriesSignature, memoriesSystemPrompt, type ProjectMemory } from './memory.ts'
import { IsolatedWorktreeBatch, mergeWorktreeChanges } from '../tools/worktrees.ts'
import { HOOK_COMPLETION_MARK, hookMatches, runHookCommand, type HookDefinition, type HookEvent } from './hooks.ts'
import { validateImages } from './attachments.ts'
import { expandPromptReferences } from './references.ts'
import { MAX_STEERING_MESSAGES, MAX_STEERING_TOTAL_CHARACTERS, normalizeSteering, steeringMessage, STEERING_SKIPPED_TOOL_RESULT } from './steering.ts'
import { assessChangeRisk, type ChangeRiskAssessment } from './risk.ts'
import { analyzeVerificationImpact, type VerificationImpact } from '../tools/testImpact.ts'
import { assessPromptInjection, assessPromptInjectionMessages, protectToolResultMessages, promptInjectionGuardPrompt, type PromptInjectionAssessment } from '../security/promptInjection.ts'
import { TaskStateTracker, type TaskStateSnapshot } from './taskState.ts'
import { ToolLoopGuard, TOOL_LOOP_BLOCKED_RESULT, TOOL_LOOP_STOPPED_REPLY, TOOL_LOOP_STOPPED_RESULT, toolLoopDeniedWarning, toolLoopSystemPrompt, toolLoopWarning } from './stall.ts'
import { toolArgumentFailure, toolArgumentSystemPrompt, validateToolArguments } from './toolArguments.ts'
import { MAX_TOOL_PROTOCOL_AUTO_FALLBACKS, normalizeToolCallIds, ToolProtocolCircuitBreaker, TOOL_PROTOCOL_STOPPED_REPLY, toolProtocolName, toolProtocolSystemPrompt, unknownToolFailure, type ToolProtocolDecision, type ToolProtocolFailureKind } from './toolProtocol.ts'
import { EvidenceCache, type EvidenceCacheHit } from './evidenceCache.ts'
import { ToolResultStore } from './toolResults.ts'
import { FailurePostmortemTracker, type FailurePostmortemReport } from './postmortem.ts'

export type AgentEvent =
  | { type: 'model-routing' }
  | ({ type: 'model-selected' } & AutoSelection)
  /**
   * Model dipanggil. Putaran 0 adalah jawaban awal atas permintaan pengguna;
   * putaran berikutnya adalah keputusan model setelah menerima hasil tool.
   */
  | { type: 'turn-start'; turn: number }
  | { type: 'reasoning'; delta: string }
  | { type: 'text'; delta: string }
  | { type: 'tool-call'; index: number; name: string; delta: string }
  | { type: 'tool-start'; name: string; preview: string; callId: string; args: Record<string, unknown> }
  /** Keluaran yang mengalir selagi tool berjalan, misalnya dari perintah bash. */
  | { type: 'tool-output'; name: string; callId: string; chunk: string }
  /** Hasil baca identik dipakai ulang dari cache task lokal. */
  | { type: 'tool-cache-hit'; name: string; callId: string; ref: string; savedCharacters: number }
  /** Output besar dipadatkan; isi lengkap tersedia sementara melalui reference opaque. */
  | { type: 'tool-result-truncated'; name: string; callId: string; ref?: string; originalCharacters: number; visibleCharacters: number }
  /** Sekelompok tool discovery opt-in dijalankan bersamaan dengan urutan hasil stabil. */
  | { type: 'tool-parallel'; stage: 'started' | 'completed'; name: 'discovery'; tools: string[]; calls: number; durationMs?: number }
  /** Tool timeout dihentikan aman; metadata ini tidak memuat command maupun output. */
  | ({ type: 'tool-recovery'; name: string; callId: string } & ToolRecovery)
  | { type: 'lsp-session'; stage: 'started' | 'reused' | 'restarted'; openDocuments: number }
  | { type: 'tool-end'; name: string; callId: string; content: string; isError: boolean; cancelled: boolean }
  | { type: 'tool-denied'; name: string; callId: string; feedback?: string }
  /** Argumen ditolak secara lokal sebelum preview, approval, dan eksekusi. */
  | { type: 'tool-invalid'; name: string; callId: string; kind: 'unknown' | 'json' | 'schema' | 'preview'; issues: string[] }
  /** Provider berulang kali hanya menghasilkan function call yang tidak valid. */
  | { type: 'tool-protocol'; stage: 'warning' | 'fallback' | 'stopped'; model: string; consecutiveTurns: number; failures: number; kinds: ToolProtocolFailureKind[] }
  /** Tool dan hasil identik berulang tanpa kemajuan; aksi berikutnya dibatasi. */
  | { type: 'tool-loop'; name: string; stage: 'warning' | 'blocked' | 'stopped'; repetitions: number }
  | { type: 'hook-start'; event: HookEvent; id: string; command: string }
  | { type: 'hook-end'; event: HookEvent; id: string; content: string; success: boolean; denied: boolean }
  | { type: 'turn-end'; message: Message }
  | { type: 'context-trimmed'; droppedMessages: number; estimatedTokens: number; prioritizedMessages: number; dependencyMessages?: number; dependencyEdges?: number }
  /** File yang pernah dibaca berubah di luar file tools; model diminta membaca ulang. */
  | { type: 'workspace-changed'; files: ObservedFileChange[]; remaining: number }
  /** Percakapan lama sedang diringkas oleh model. */
  | { type: 'compacting' }
  | { type: 'compacted'; summarizedMessages: number; estimatedTokens: number }
  /** Ringkasan gagal; pesan lama dipangkas seperti biasa sebagai gantinya. */
  | { type: 'compaction-failed'; message: string }
  /** Pengguna menghentikan pekerjaan; riwayat sudah dirapikan dan tetap sah. */
  | { type: 'cancelled' }
  /** Berkas aturan proyek berubah sejak permintaan sebelumnya dan sudah dimuat ulang. */
  | { type: 'instructions-reloaded'; files: InstructionFile[] }
  /** Panggilan model gagal sementara dan akan diulang setelah jeda. */
  | { type: 'retry'; attempt: number; maxAttempts: number; delayMs: number; message: string }
  /** Batas langkah tercapai dan pengguna memilih berhenti. */
  | { type: 'turn-limit'; turns: number }
  /** Agent akan memeriksa perubahan sebelum diizinkan menyimpulkan pekerjaan. */
  | { type: 'verification-needed'; files: string[]; tests?: string[]; commands?: string[] }
  /** Ringkasan graph dampak tanpa source atau path, aman untuk trace lokal. */
  | { type: 'change-impact'; changedFiles: number; affectedFiles: number; tests: number; edges: number; maxDepth: number; blastRadius: 'small' | 'medium' | 'large'; truncated: boolean }
  /** Status durable yang dicatat segera setelah mutasi atau verifikasi. */
  | { type: 'verification-state'; status: 'needed' | 'complete'; revision: number }
  /** Model tetap menyimpulkan tanpa bukti verifikasi setelah sudah diingatkan. */
  | { type: 'verification-incomplete'; files: string[]; attempted: boolean }
  /** Loop bounded untuk mendiagnosis, memperbaiki, dan menjalankan ulang verifikasi gagal. */
  | { type: 'verification-repair'; stage: 'needed' | 'retrying' | 'repaired' | 'exhausted'; round: number; maxRounds: number; revision: number }
  /** Reviewer independen berjalan tanpa tool sebelum task kompleks ditutup. */
  | { type: 'critic-start'; round: number }
  | { type: 'critic-end'; round: number; model: string; status: 'pass' | 'findings' | 'error' | 'limit'; findings: number; message?: string }
  /** Arahan live sudah disisipkan ke riwayat pada batas aman antaraksi. */
  | { type: 'steering'; messages: string[] }
  /** Risiko dihitung lokal dari diff checkpoint, bukan dari isi prompt saja. */
  | { type: 'risk-assessed'; assessment: ChangeRiskAssessment }
  /** Data tool memuat pola instruksi terselubung; aksi berikutnya wajib approval baru. */
  | { type: 'prompt-injection-detected'; tool: string; source: PromptInjectionAssessment['source']; categories: PromptInjectionAssessment['categories'] }
  /** Pemeriksaan kuat tidak tersedia sesudah satu pengingat; pekerjaan tetap direview. */
  | { type: 'risk-verification-weak'; assessment: ChangeRiskAssessment }
  /** Diagnosis lokal setelah task gagal/berhenti; tidak memuat prompt, source, args, output, atau path. */
  | { type: 'failure-postmortem'; report: FailurePostmortemReport }
  | { type: 'error'; message: string }

/** Ditanyakan sebelum tool berisiko dijalankan. */
/**
 * Keputusan izin. `feedback` diisi bila pengguna menolak sambil memberi arahan;
 * arahan itu diteruskan ke model sebagai hasil tool, supaya penolakan menjadi
 * petunjuk langkah berikutnya, bukan jalan buntu.
 */
export interface PermissionDecision {
  allowed: boolean
  feedback?: string
}

export type PermissionAsker = (request: {
  name: string
  preview: string
  args: Record<string, unknown>
  /** False untuk aksi eksternal yang tidak boleh mendapat izin berulang per sesi. */
  allowAlways: boolean
  /** Output tidak tepercaya sebelumnya memuat sinyal prompt injection. */
  promptInjectionRisk?: boolean
  /** Diff perubahan bila tool menyediakannya; null berarti tak ada yang berubah. */
  detail: DiffLine[] | null
}) => Promise<boolean | PermissionDecision>

export interface AgentOptions {
  modelMode?: ModelMode
  provider: NineRouterProvider
  registry: ToolRegistry
  workspace: string
  /** Home untuk katalog skill global dan tool yang memang membutuhkannya. */
  home?: string
  /** ID sesi stabil untuk menyimpan checkpoint /undo lintas restart. */
  sessionId?: string
  askPermission: PermissionAsker
  /** Meminta keputusan requirement/arsitektur yang tidak bisa disimpulkan dari repo. */
  askUser?: UserAsker
  /** Lifecycle hooks dimuat ulang pada awal setiap permintaan. */
  hooks?: () => HookDefinition[]
  /**
   * Jumlah putaran sebelum pengguna ditanya apakah pekerjaan dilanjutkan, agar
   * model yang tersesat tidak berputar selamanya tanpa sepengetahuan pengguna.
   */
  maxTurns?: number
  /**
   * Ditanyakan setiap kali `maxTurns` putaran lagi terlewati. Mengembalikan true
   * untuk melanjutkan. Tanpa callback ini, pekerjaan berhenti di batas.
   */
  onTurnLimit?: (turns: number) => Promise<boolean>
  /** Jeda sebelum setiap pengulangan panggilan model yang gagal sementara. */
  retryDelaysMs?: number[]
  /** Anggaran token untuk pesan yang dikirim; riwayat lama dipangkas di atasnya. */
  maxContextTokens?: number
  /** Matikan hanya untuk harness khusus; sesi pengguna mengaktifkannya secara bawaan. */
  verifyCompletion?: boolean
  /** Reviewer model kedua untuk perubahan kompleks; default aktif. */
  autoReview?: boolean
  /** Batas filesystem/network untuk tool command. */
  sandbox?: SandboxPolicy
  /**
   * Riwayat sesi sebelumnya untuk dilanjutkan. Diperbaiki lebih dulu, karena
   * sesi yang terputus dapat memuat panggilan tool tanpa hasil.
   */
  history?: Message[]
  /**
   * Dipanggil setiap kali pesan baru masuk ke riwayat, dalam urutan yang sama.
   * Riwayat yang dipulihkan dari `history` tidak ikut dilaporkan.
   */
  onMessage?: (message: Message) => void
  /** Ringkasan dari sesi yang dilanjutkan, beserta titik potongnya di `history`. */
  compaction?: Compaction
  /** Dipanggil setiap kali ringkasan baru dibuat, untuk disimpan bersama sesi. */
  onCompaction?: (compaction: Compaction) => void
  systemPrompt?: string
  /**
   * Membaca berkas aturan proyek. Dipanggil saat agent dibuat dan sebelum setiap
   * permintaan, supaya aturan yang baru diubah langsung berlaku.
   */
  instructions?: (targets?: readonly string[]) => InstructionFile[]
  /** Katalog skill dimuat ke prompt sebagai metadata; isinya dibaca on-demand. */
  skills?: () => SkillDefinition[]
  /** Catatan satu kali dari jurnal run yang terputus; tidak masuk history sesi. */
  recoveryPrompt?: string
}

const DEFAULT_MAX_TURNS = 40
const MAX_PARALLEL_DISCOVERY = 4
/** Limit dan gangguan 9Router biasanya pulih dalam hitungan detik. */
export const DEFAULT_RETRY_DELAYS_MS = [2_000, 5_000, 15_000]

export const CANCELLED_TOOL_RESULT = 'Dibatalkan: pengguna menghentikan pekerjaan sebelum tool ini selesai.'
export const CANCELLED_REPLY = '(Dibatalkan oleh pengguna.)'
/** Awalan jawaban pengganti saat panggilan model gagal; diikuti pesan error dan `)`. */
export const FAILED_REPLY_PREFIX = '(Gagal: '
/** Awalan jawaban pengganti saat pengguna memilih berhenti di batas langkah. */
export const TURN_LIMIT_REPLY_PREFIX = '(Berhenti setelah '

export function turnLimitReply(turns: number): string {
  return `${TURN_LIMIT_REPLY_PREFIX}${turns} langkah atas permintaan pengguna; pekerjaan belum tentu selesai.)`
}

function isFailureTerminal(event: AgentEvent): boolean {
  return event.type === 'error' || event.type === 'turn-limit' || event.type === 'verification-incomplete'
    || event.type === 'tool-loop' && event.stage === 'stopped'
    || event.type === 'tool-protocol' && event.stage === 'stopped'
}

/** Menunggu, tetapi selesai lebih awal bila pengguna menghentikan pekerjaan. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}

export interface SendOptions {
  /** Menyala saat pengguna menghentikan pekerjaan, misalnya lewat Esc. */
  signal?: AbortSignal
  /** Review/plan membatasi tool dan memaksa operasi yang diizinkan menjadi read-only. */
  mode?: 'normal' | 'review' | 'plan'
  /** Gambar yang dilampirkan pengguna untuk model multimodal. */
  images?: ImageAttachment[]
}
/** Balasan kosong sesekali terjadi pada 9Router; sekali ulang sudah cukup. */
const EMPTY_REPLY_RETRIES = 1

interface ParallelDiscoveryItem {
  call: ToolCall
  tool: Tool
  args: Record<string, unknown>
  preview: string
}

function canonicalToolArguments(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? String(value)
  if (Array.isArray(value)) return `[${value.map(canonicalToolArguments).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalToolArguments(entry)}`).join(',')}}`
}

/** Hanya tool discovery valid, unik, opt-in, dan tanpa hook/side effect yang boleh paralel. */
function prepareParallelDiscovery(
  calls: readonly ToolCall[],
  start: number,
  registry: ToolRegistry,
  hooks: readonly HookDefinition[],
): ParallelDiscoveryItem[] {
  const candidates = calls.slice(start, start + MAX_PARALLEL_DISCOVERY)
  const items: ParallelDiscoveryItem[] = []
  const identities = new Set<string>()
  for (const call of candidates) {
    const tool = registry.get(call.function.name)
    if (!tool || tool.risk !== 'safe' || tool.parallelSafe !== true || tool.writesWorkspace || tool.mutatesWorkspace || tool.runsCommand) break
    if (hooks.some((hook) => hookMatches(hook, 'before_tool', tool.name) || hookMatches(hook, 'after_tool', tool.name))) break
    let parsed: unknown
    try { parsed = JSON.parse(call.function.arguments || '{}') } catch { break }
    if (validateToolArguments(tool.schema.function.parameters, parsed).length) break
    const args = parsed as Record<string, unknown>
    const identity = `${tool.name}\n${canonicalToolArguments(args)}`
    if (identities.has(identity)) break
    let preview: string
    try { preview = tool.preview(args as never) } catch { break }
    identities.add(identity)
    items.push({ call, tool, args, preview })
  }
  return items.length >= 2 ? items : []
}

export class Agent {
  private readonly autoRouter: AutoModelRouter
  private readonly fileSnapshots = new FileSnapshots()
  private mode: ModelMode
  private autoSelection: AutoSelection | null = null
  private readonly messages: Message[] = []
  private readonly options: AgentOptions
  private instructionFiles: InstructionFile[]
  /** Target yang pernah disentuh agar aturan scoped tetap aktif sepanjang sesi. */
  private readonly instructionTargets = new Set<string>()
  private skillDefinitions: SkillDefinition[]
  private projectMemories: ProjectMemory[]
  private pendingRecoveryPrompt: string
  /** Ringkasan bagian lama riwayat, bila konteks pernah hampir penuh. */
  private compaction: Compaction | null = null
  /** Titik pemulihan berkas per permintaan, untuk /undo. */
  readonly checkpoints: Checkpoints
  /** State lokal untuk /status; tidak memanggil model dan tidak memakai DB. */
  private readonly taskStateTracker: TaskStateTracker
  /** Catatan /undo yang disisipkan di awal permintaan berikutnya. */
  private pendingNote = ''
  /** Arahan yang diterima surface ketika request ini masih aktif. */
  private readonly pendingSteering: string[] = []
  private acceptingSteering = false
  /** Mencegah surface mengulang notice yang sama pada setiap turn. */
  private lastFreshnessSignature = ''

  /** Hasil perbaikan riwayat yang dipulihkan, atau null untuk sesi baru. */
  readonly restored: RepairResult | null

  constructor(options: AgentOptions) {
    this.options = options
    this.autoRouter = new AutoModelRouter({ home: options.home })
    this.mode = options.modelMode ?? 'manual'
    this.checkpoints = new Checkpoints(options.workspace, { home: options.home, sessionId: options.sessionId })
    this.instructionFiles = options.instructions?.() ?? []
    this.skillDefinitions = options.skills?.() ?? []
    this.projectMemories = loadProjectMemories(options.workspace, options.home)
    this.pendingRecoveryPrompt = options.recoveryPrompt?.trim() ?? ''
    this.messages.push({
      role: 'system',
      content: composeSystemPrompt(options.systemPrompt ?? BOO_SYSTEM_PROMPT, this.instructionFiles, this.skillDefinitions),
    })
    this.restored = options.history?.length ? repairHistory(options.history) : null
    if (this.restored) this.messages.push(...this.restored.messages)
    this.taskStateTracker = new TaskStateTracker(this.messages.slice(1), options.provider.model, options.provider.reasoningEffort)
    if (options.compaction && this.restored) {
      // Perbaikan riwayat dapat menyisipkan pesan; titik potong diselaraskan ulang.
      this.compaction = { summary: options.compaction.summary, upTo: alignCut(this.restored.messages, options.compaction.upTo) }
    }
  }

  /** Pesan yang dikirim ke model sebelum pemangkasan: bagian lama diganti ringkasan. */
  private contextMessages(extraSystemPrompt?: string): Message[] {
    const memoryPrompt = memoriesSystemPrompt(this.projectMemories)
    return [
      this.messages[0],
      ...(memoryPrompt ? [{ role: 'system' as const, content: memoryPrompt }] : []),
      ...(extraSystemPrompt ? [{ role: 'system' as const, content: extraSystemPrompt }] : []),
      ...applyCompaction(this.messages.slice(1), this.compaction),
    ]
  }

  /** Ringkasan yang sedang berlaku, bila ada. */
  get currentCompaction(): Compaction | null {
    return this.compaction
  }

  /** Potret lokal konteks yang akan dipakai model; tidak memanggil provider. */
  contextReport(): ContextReport {
    return inspectContext(
      this.contextMessages(),
      this.options.registry.schemas(),
      this.options.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS,
      {
        historyMessages: Math.max(0, this.messages.length - 1),
        summarizedMessages: this.compaction?.upTo ?? 0,
      },
    )
  }

  /** Status task aktif/terakhir ditambah perubahan checkpoint aktual. */
  async taskStatus(): Promise<TaskStateSnapshot> {
    let plan: UndoPlan | null = null
    try { plan = await this.checkpoints.currentPlan() } catch { /* Event tetap memberi status bila file sedang tak terbaca. */ }
    return this.taskStateTracker.snapshot(Date.now(), {
      files: plan?.entries.map((entry) => entry.label) ?? [],
      ranCommands: plan?.ranCommands ?? false,
    })
  }

  /**
   * Meringkas percakapan sekarang juga, misalnya lewat /compact. Seluruh riwayat
   * sampai saat ini diringkas; permintaan berikutnya dimulai dengan ringkasan itu.
   */
  async *compact({ signal }: SendOptions = {}): AsyncGenerator<AgentEvent> {
    yield* this.summarize(this.messages.length - 1, signal)
  }

  /** Membuat ringkasan bila pesan yang akan dikirim sudah mendekati batas konteks. */
  private async *compactIfNeeded(signal: AbortSignal | undefined, schemas: readonly ToolSchema[]): AsyncGenerator<AgentEvent> {
    const budget = this.options.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS
    const size = this.contextMessages().reduce((total, message) => total + estimateMessageTokens(message), 0)
      + estimateToolSchemaTokens(schemas)
    if (size <= budget * COMPACT_THRESHOLD) return
    const cut = chooseCut(this.messages.slice(1), this.compaction?.upTo ?? 0, messageContextBudget(budget, schemas))
    if (cut !== null) yield* this.summarize(cut, signal)
  }

  private async *summarize(cut: number, signal: AbortSignal | undefined): AsyncGenerator<AgentEvent> {
    const history = this.messages.slice(1)
    const from = this.compaction?.upTo ?? 0
    if (cut <= from) return
    const budget = this.options.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS
    yield { type: 'compacting' }

    // Bahan ringkasan dibatasi sekitar separuh anggaran, agar permintaannya sendiri muat.
    const transcript = renderForSummary(history.slice(from, cut), Math.floor(budget * 0.5) * 4)
    let summary: string
    try {
      const stream = this.options.provider.stream(summaryRequest(this.compaction?.summary, transcript), [], signal)
      let next = await stream.next()
      while (!next.done) next = await stream.next()
      summary = next.value.message.content?.trim() ?? ''
    } catch (error) {
      if (signal?.aborted) throw error
      yield { type: 'compaction-failed', message: error instanceof Error ? error.message : 'Ringkasan gagal dibuat.' }
      return
    }
    if (!summary) {
      yield { type: 'compaction-failed', message: 'Model tidak mengembalikan ringkasan.' }
      return
    }

    this.compaction = { summary, upTo: cut }
    this.options.onCompaction?.(this.compaction)
    const estimatedTokens = this.contextMessages().reduce((total, message) => total + estimateMessageTokens(message), 0)
    yield { type: 'compacted', summarizedMessages: cut - from, estimatedTokens }
  }

  /** Aturan proyek yang sedang berlaku. */
  get instructions(): readonly InstructionFile[] {
    return this.instructionFiles
  }

  /** Memuat ulang aturan proyek; mengembalikan true bila isinya berubah. */
  private reloadInstructions(targets: readonly string[] = []): boolean {
    targets.forEach((target) => this.instructionTargets.add(target))
    const files = this.options.instructions?.([...this.instructionTargets]) ?? this.instructionFiles
    const skills = this.options.skills?.() ?? this.skillDefinitions
    const memories = loadProjectMemories(this.options.workspace, this.options.home)
    const instructionsChanged = instructionsSignature(files) !== instructionsSignature(this.instructionFiles)
    const skillsChanged = skillsSignature(skills) !== skillsSignature(this.skillDefinitions)
    const memoriesChanged = memoriesSignature(memories) !== memoriesSignature(this.projectMemories)
    if (!instructionsChanged && !skillsChanged && !memoriesChanged) return false
    this.instructionFiles = files
    this.skillDefinitions = skills
    this.projectMemories = memories
    this.messages[0] = {
      role: 'system',
      content: composeSystemPrompt(this.options.systemPrompt ?? BOO_SYSTEM_PROMPT, files, skills),
    }
    return instructionsChanged
  }

  /**
   * Membatalkan perubahan berkas dari permintaan terakhir yang mengubah berkas.
   * Model diberi tahu pada permintaan berikutnya, karena riwayatnya masih
   * menyebut perubahan itu sudah dibuat.
   */
  async undo(): Promise<UndoPlan | null> {
    const plan = await this.checkpoints.undo()
    if (plan?.entries.length) this.pendingNote = [this.pendingNote, undoNote(plan)].filter(Boolean).join('\n')
    return plan
  }

  /** Memulihkan beberapa checkpoint file tanpa mengubah riwayat percakapan. */
  async restore(checkpointId: number, fingerprint: string): Promise<RestorePlan | null> {
    const plan = await this.checkpoints.restore(checkpointId, fingerprint)
    if (plan) this.pendingNote = [this.pendingNote, restoreNote(plan)].filter(Boolean).join('\n')
    return plan
  }

  get history(): readonly Message[] {
    return this.messages
  }

  get modelMode(): ModelMode { return this.mode }
  get lastAutoSelection(): AutoSelection | null { return this.autoSelection }

  /**
   * Menambahkan koreksi untuk request yang sedang berjalan. Nilai 0 berarti tidak
   * ada request aktif, sehingga surface dapat memasukkannya sebagai task berikutnya.
   */
  steer(input: string): number {
    if (!this.acceptingSteering) return 0
    const text = normalizeSteering(input)
    if (this.pendingSteering.length >= MAX_STEERING_MESSAGES) throw new Error(`Maksimal ${MAX_STEERING_MESSAGES} arahan tengah jalan per request.`)
    const total = this.pendingSteering.reduce((sum, item) => sum + item.length, 0) + text.length
    if (total > MAX_STEERING_TOTAL_CHARACTERS) throw new Error(`Total arahan tengah jalan maksimal ${MAX_STEERING_TOTAL_CHARACTERS.toLocaleString('id-ID')} karakter.`)
    this.pendingSteering.push(text)
    return this.pendingSteering.length
  }

  /** Menyisipkan seluruh arahan sebagai satu pesan user hanya pada batas aman. */
  private applySteering(prefix?: string): string[] {
    const messages = this.pendingSteering.splice(0)
    if (messages.length) this.append({ role: 'user', content: [prefix, steeringMessage(messages)].filter(Boolean).join('\n\n') })
    return messages
  }

  setModelMode(mode: ModelMode): void {
    if (this.mode !== mode) this.autoRouter.reset()
    this.autoSelection = null
    this.mode = mode
  }

  private async *runHooks(
    hooks: readonly HookDefinition[],
    event: HookEvent,
    toolName: string | undefined,
    sandbox: SandboxPolicy | undefined,
    signal: AbortSignal | undefined,
    promptInjectionRisk = false,
  ): AsyncGenerator<AgentEvent, { failed: boolean; denied: boolean; cancelled: boolean; mutated: boolean; verified: boolean; content: string }> {
    let failed = false
    let denied = false
    let cancelled = false
    let mutated = false
    let verified = false
    const reports: string[] = []
    for (const hook of hooks.filter((candidate) => hookMatches(candidate, event, toolName))) {
      if (signal?.aborted) { cancelled = true; break }
      const args = { command: hook.command, description: `Hook ${event}: ${hook.id}`, timeout: hook.timeoutSeconds }
      const answer = await this.options.askPermission({
        name: 'bash', preview: hook.command, args, allowAlways: !promptInjectionRisk,
        ...(promptInjectionRisk ? { promptInjectionRisk: true } : {}), detail: null,
      })
      if (signal?.aborted) { cancelled = true; break }
      const decision = typeof answer === 'boolean' ? { allowed: answer } : answer
      if (!decision.allowed) {
        denied = true
        const content = decision.feedback?.trim() ? `Hook ditolak: ${decision.feedback.trim()}` : 'Hook ditolak pengguna.'
        reports.push(`${hook.id}: ${content}`)
        yield { type: 'hook-end', event, id: hook.id, content, success: false, denied: true }
        continue
      }
      yield { type: 'hook-start', event, id: hook.id, command: hook.command }
      if (hook.mutatesWorkspace) this.checkpoints.noteCommand()
      const result = await runHookCommand(hook, { workspace: this.options.workspace, sandbox, signal })
      failed ||= !result.success
      cancelled ||= result.cancelled
      // Command gagal tetap dapat mengubah sebagian workspace sebelum exit nonzero.
      mutated ||= !result.cancelled && hook.mutatesWorkspace
      verified ||= result.success && hook.verifiesWorkspace
      reports.push(`${hook.id}: ${result.content}`)
      yield { type: 'hook-end', event, id: hook.id, content: result.content, success: result.success, denied: false }
      if (cancelled) break
    }
    return { failed, denied, cancelled, mutated, verified, content: reports.join('\n\n') }
  }

  /** Satu panggilan model terisolasi: tidak menerima tool dan tidak mengubah history langsung. */
  private async runAutomaticCritic(
    provider: NineRouterProvider,
    task: string,
    verificationAttempts: readonly VerificationAttempt[],
    impact?: VerificationImpact,
    signal?: AbortSignal,
  ): Promise<{ model: string; result: CriticResult | null; error?: string }> {
    let reviewerModel = provider.model
    let reviewerEffort = provider.reasoningEffort
    try {
      const deadline = AbortSignal.timeout(8_000)
      const ids = await provider.listModels(signal ? AbortSignal.any([signal, deadline]) : deadline)
      const alternative = selectAutoModel(ids.filter((id) => id !== provider.model), 'complex')
      if (alternative) {
        reviewerModel = alternative.modelId
        reviewerEffort = alternative.reasoningEffort
      }
    } catch {
      signal?.throwIfAborted()
      // Discovery opsional: model aktif tetap dapat menjadi critic independen.
    }
    const changes = await this.checkpoints.currentChanges()
    if (!changes.length) return { model: reviewerModel, result: { verdict: 'pass', findings: [] } }
    try {
      const reviewer = provider.fork(reviewerModel, reviewerEffort)
      const stream = reviewer.stream([
        { role: 'system', content: AUTO_REVIEW_SYSTEM_PROMPT },
        { role: 'user', content: automaticReviewRequest(task, changes, verificationAttempts, impact) },
      ], [], signal)
      let raw = ''
      for (;;) {
        const event = await stream.next()
        if (event.done) {
          raw = event.value.message.content ?? raw
          break
        }
        if (event.value.type === 'text' && raw.length < 64_000) raw += event.value.delta.slice(0, 64_000 - raw.length)
      }
      const result = parseCriticResult(raw)
      return result
        ? { model: reviewerModel, result }
        : { model: reviewerModel, result: null, error: 'Reviewer mengembalikan format yang tidak valid; hasil diabaikan.' }
    } catch (error) {
      signal?.throwIfAborted()
      return { model: reviewerModel, result: null, error: error instanceof Error ? error.message : 'Reviewer gagal.' }
    }
  }

  /** Menjalankan satu agent terisolasi dengan tool baca-saja dan tanpa riwayat induk. */
  private async runDelegatedTask(
    task: DelegatedTask,
    maxTurns: number,
    signal: AbortSignal | undefined,
    onProgress: (chunk: string) => void,
  ): Promise<DelegatedResult> {
    let turns = 0
    let toolCalls = 0
    let failure = ''
    let cancelled = false
    const child = new Agent({
      provider: this.options.provider,
      registry: createSubagentRegistry(),
      workspace: this.options.workspace,
      home: this.options.home,
      askPermission: async () => false,
      maxTurns,
      retryDelaysMs: this.options.retryDelaysMs,
      maxContextTokens: Math.min(this.options.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS, 32_000),
      verifyCompletion: false,
      sandbox: { ...this.options.sandbox, mode: 'read-only' },
      systemPrompt: SUBAGENT_SYSTEM_PROMPT,
      instructions: this.options.instructions,
      skills: this.options.skills,
    })

    for await (const event of child.send(task.task, { signal })) {
      if (event.type === 'turn-start') turns = Math.max(turns, event.turn + 1)
      else if (event.type === 'tool-start') {
        toolCalls += 1
        onProgress(`[${task.id}] ${event.preview}\n`)
      } else if (event.type === 'retry') {
        onProgress(`[${task.id}] mencoba ulang model (${event.attempt}/${event.maxAttempts})…\n`)
      } else if (event.type === 'error') failure = event.message
      else if (event.type === 'turn-limit') failure = `Batas ${event.turns} putaran tercapai.`
      else if (event.type === 'cancelled') cancelled = true
    }

    const report = [...child.history].reverse().find((message) => message.role === 'assistant' && !message.tool_calls?.length)?.content?.trim() ?? ''
    if (cancelled || signal?.aborted) return { id: task.id, status: 'cancelled', content: report || 'Dibatalkan oleh pengguna.', turns, toolCalls }
    if (failure) return { id: task.id, status: 'failed', content: report || failure, turns, toolCalls }
    return { id: task.id, status: 'completed', content: report || 'Sub-agent selesai tanpa laporan teks.', turns, toolCalls }
  }

  /** Menjalankan implementasi paralel, kemudian merge hasil per task secara serial. */
  private async runWritableDelegatedTasks(
    tasks: DelegatedTask[],
    maxTurns: number,
    signal: AbortSignal | undefined,
    onProgress: (chunk: string) => void,
  ): Promise<DelegatedResult[]> {
    let batch: IsolatedWorktreeBatch
    try {
      batch = await IsolatedWorktreeBatch.create({
        workspace: this.options.workspace,
        home: this.options.home,
        ...(signal ? { signal } : {}),
      })
    } catch (error) {
      const content = `Gagal menyiapkan Git worktree: ${error instanceof Error ? error.message : 'error tidak dikenal'}`
      return tasks.map((task) => ({ id: task.id, status: 'failed', content, turns: 0, toolCalls: 0 }))
    }

    try {
      const prepared = [] as Array<{ task: DelegatedTask; path: string } | { task: DelegatedTask; error: string }>
      for (const task of tasks) {
        try {
          onProgress(`[${task.id}] menyiapkan worktree…\n`)
          const lease = await batch.prepare(task.id, signal)
          prepared.push({ task, path: lease.path })
        } catch (error) {
          prepared.push({ task, error: error instanceof Error ? error.message : 'worktree gagal disiapkan' })
        }
      }

      const executions = await Promise.all(prepared.map(async (entry): Promise<{ result: DelegatedResult; changes: Awaited<ReturnType<Checkpoints['currentChanges']>> }> => {
        if ('error' in entry) {
          return {
            result: { id: entry.task.id, status: 'failed', content: `Gagal menyiapkan worktree: ${entry.error}`, turns: 0, toolCalls: 0 },
            changes: [],
          }
        }
        let turns = 0
        let toolCalls = 0
        let failure = ''
        let cancelled = false
        const child = new Agent({
          provider: this.options.provider,
          registry: createWritableSubagentRegistry(),
          workspace: entry.path,
          home: this.options.home,
          // Approval parent untuk delegate_write mencakup file tools di worktree ini.
          askPermission: async () => true,
          maxTurns,
          retryDelaysMs: this.options.retryDelaysMs,
          maxContextTokens: Math.min(this.options.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS, 32_000),
          verifyCompletion: false,
          sandbox: { mode: 'workspace-write', networkAccess: false },
          systemPrompt: WRITABLE_SUBAGENT_SYSTEM_PROMPT,
          instructions: (targets) => loadInstructions({ workspace: entry.path, home: this.options.home, targets }),
          skills: () => this.skillDefinitions,
        })
        try {
          for await (const event of child.send(entry.task.task, { signal })) {
            if (event.type === 'turn-start') turns = Math.max(turns, event.turn + 1)
            else if (event.type === 'tool-start') {
              toolCalls += 1
              onProgress(`[${entry.task.id}] ${event.preview}\n`)
            } else if (event.type === 'retry') {
              onProgress(`[${entry.task.id}] mencoba ulang model (${event.attempt}/${event.maxAttempts})…\n`)
            } else if (event.type === 'error') failure = event.message
            else if (event.type === 'turn-limit') failure = `Batas ${event.turns} putaran tercapai.`
            else if (event.type === 'cancelled') cancelled = true
          }
        } catch (error) {
          failure = error instanceof Error ? error.message : 'Sub-agent gagal.'
        }
        const report = [...child.history].reverse().find((message) => message.role === 'assistant' && !message.tool_calls?.length)?.content?.trim() ?? ''
        const changes = await child.checkpoints.currentChanges()
        if (cancelled || signal?.aborted) {
          return { result: { id: entry.task.id, status: 'cancelled', content: report || 'Dibatalkan oleh pengguna.', turns, toolCalls }, changes: [] }
        }
        if (failure) {
          return { result: { id: entry.task.id, status: 'failed', content: report || failure, turns, toolCalls }, changes: [] }
        }
        return {
          result: { id: entry.task.id, status: 'completed', content: report || 'Sub-agent selesai tanpa laporan teks.', turns, toolCalls },
          changes,
        }
      }))

      // Merge serial membuat konflik antarsub-agent deterministik: task yang
      // muncul lebih dulu menang, task berikutnya melaporkan path konflik.
      for (const execution of executions) {
        if (execution.result.status !== 'completed' || !execution.changes.length) continue
        try {
          const merged = await mergeWorktreeChanges(this.options.workspace, execution.changes, {
            checkpoint: this.checkpoints,
            fileSnapshots: this.fileSnapshots,
          })
          execution.result.changedFiles = merged.applied
          if (merged.conflicts.length) {
            execution.result.status = 'conflicted'
            execution.result.conflicts = merged.conflicts
            execution.result.content = `${execution.result.content}\n\nPerubahan tidak digabungkan karena path tujuan berubah setelah snapshot dibuat.`
          } else if (merged.applied.length) {
            onProgress(`[${execution.result.id}] digabungkan: ${merged.applied.join(', ')}\n`)
          }
        } catch (error) {
          execution.result.status = 'failed'
          execution.result.content = `${execution.result.content}\n\nMerge gagal: ${error instanceof Error ? error.message : 'error tidak dikenal'}`
        }
      }
      return executions.map((execution) => execution.result)
    } finally {
      await batch.close()
    }
  }

  /** Menjaga satu request aktif dan membersihkan arahan yang belum sempat dipakai. */
  async *send(userInput: string, { signal, mode = 'normal', images = [] }: SendOptions = {}): AsyncGenerator<AgentEvent> {
    if (this.acceptingSteering) throw new Error('Agent sudah menjalankan request lain.')
    this.acceptingSteering = true
    this.taskStateTracker.begin(userInput, this.options.provider.model, this.options.provider.reasoningEffort)
    const postmortem = new FailurePostmortemTracker({
      workspace: this.options.workspace,
      home: this.options.home,
      model: this.options.provider.model,
      reasoningEffort: this.options.provider.reasoningEffort,
    })
    let clean = false
    let failed = false
    try {
      for await (const event of this.runRequest(userInput, { signal, mode, images })) {
        postmortem.record(event)
        if (isFailureTerminal(event)) {
          const report = postmortem.finish()
          if (report) {
            const postmortemEvent: AgentEvent = { type: 'failure-postmortem', report }
            this.taskStateTracker.record(postmortemEvent)
            yield postmortemEvent
          }
        }
        this.taskStateTracker.record(event)
        yield event
      }
      clean = true
      const report = postmortem.finish()
      if (report) {
        const event: AgentEvent = { type: 'failure-postmortem', report }
        this.taskStateTracker.record(event)
        yield event
      }
    } catch (error) {
      failed = true
      postmortem.recordThrown(error)
      const report = postmortem.finish()
      if (report) {
        const event: AgentEvent = { type: 'failure-postmortem', report }
        this.taskStateTracker.record(event)
        yield event
      }
      throw error
    } finally {
      this.taskStateTracker.finish(clean, Date.now(), failed ? 'error' : 'stopped')
      this.acceptingSteering = false
      this.pendingSteering.length = 0
    }
  }

  /** Menjalankan satu permintaan pengguna sampai tuntas. */
  private async *runRequest(userInput: string, { signal, mode = 'normal', images = [] }: SendOptions = {}): AsyncGenerator<AgentEvent> {
    validateImages(images)
    let instructionsChanged = this.reloadInstructions()
    const referenced = expandPromptReferences(userInput, this.options.workspace)
    instructionsChanged = this.reloadInstructions(referenced.references.map((reference) => reference.path)) || instructionsChanged
    if (instructionsChanged) yield { type: 'instructions-reloaded', files: [...this.instructionFiles] }
    const note = this.pendingNote
    this.pendingNote = ''
    this.append({ role: 'user', content: note ? `${note}\n\n${referenced.prompt}` : referenced.prompt, ...(images.length ? { images } : {}) })
    this.checkpoints.begin(userInput)
    const { provider, registry: configuredRegistry, maxTurns = DEFAULT_MAX_TURNS } = this.options
    const readOnly = mode === 'review' || mode === 'plan'
    const registry = readOnly ? createReviewRegistry(configuredRegistry) : configuredRegistry
    registry.beginTask?.()
    this.autoRouter.beginTask()
    const toolSandbox = readOnly ? { ...this.options.sandbox, mode: 'read-only' as const } : this.options.sandbox
    const lifecycleHooks = this.options.hooks?.() ?? []
    let autoFallbacks = 0
    let protocolFallbacks = 0
    let mutationRevision = 0
    let verifiedRevision = -1
    let lastRemindedRevision = -1
    let reviewedRevision = -1
    let riskAssessedRevision = -1
    let riskReminderRevision = -1
    let criticRounds = 0
    const verificationAttempts: VerificationAttempt[] = []
    let latestImpact: VerificationImpact | undefined
    const verificationRepair = new VerificationRepairLoop()
    const toolLoopGuard = new ToolLoopGuard()
    const toolProtocolGuard = new ToolProtocolCircuitBreaker()
    const evidenceCache = new EvidenceCache()
    const toolResults = new ToolResultStore()
    let toolLoopReminder = ''
    let toolArgumentReminder = ''
    let toolProtocolReminder = ''
    const promptInjectionAssessments: PromptInjectionAssessment[] = assessPromptInjectionMessages(this.contextMessages())
    const referenceInjection = referenced.untrustedText ? assessPromptInjection('workspace_reference', referenced.untrustedText) : null
    if (referenceInjection?.suspicious) {
      promptInjectionAssessments.push(referenceInjection)
      yield { type: 'prompt-injection-detected', tool: referenceInjection.tool, source: referenceInjection.source, categories: referenceInjection.categories }
    }
    const recoveryPrompt = this.pendingRecoveryPrompt
    const appliedSteering: string[] = []
    const applySteering = (prefix?: string) => {
      const messages = this.applySteering(prefix)
      appliedSteering.push(...messages)
      return messages
    }
    const routingSignals = [
      images.length ? `[${images.length} image attachment(s)]` : '',
      referenced.references.length ? `[${referenced.references.length} explicitly referenced workspace path(s): ${referenced.references.map((item) => item.path).join(', ')}]` : '',
    ].filter(Boolean).join('\n')
    const autoRoutingInput = routingSignals ? `${userInput}\n\n${routingSignals}` : userInput
    const autoRequirements: ProviderRequirements = {
      vision: images.length > 0,
      tools: registry.schemas().length > 0,
      contextTokens: inspectContext(
        this.contextMessages(), registry.schemas(), this.options.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS,
      ).sentTokens,
      reasoning: true,
    }

    if (this.mode === 'auto' && !signal?.aborted) {
      yield { type: 'model-routing' }
      try {
        const selected = await this.autoRouter.route(provider, autoRoutingInput, this.messages.slice(1, -1), signal, autoRequirements)
        provider.model = selected.model
        provider.reasoningEffort = selected.reasoningEffort
        this.autoSelection = selected
        yield { type: 'model-selected', ...selected }
      } catch (error) {
        if (signal?.aborted) {
          this.settleCancellation('')
          yield { type: 'cancelled' }
        } else {
          const message = error instanceof Error ? error.message : 'Pemilihan model Auto gagal.'
          this.settle('', `${FAILED_REPLY_PREFIX}${message})`)
          yield { type: 'error', message }
        }
        return
      }
    }

    turnLoop: for (let turn = 0; ; turn += 1) {
      if (turn > 0 && turn % maxTurns === 0) {
        const proceed = await this.options.onTurnLimit?.(turn) ?? false
        if (!proceed && !signal?.aborted) {
          this.settle('', turnLimitReply(turn))
          yield { type: 'turn-limit', turns: turn }
          return
        }
      }
      if (signal?.aborted) {
        this.settleCancellation('')
        yield { type: 'cancelled' }
        return
      }
      // Tool sebelumnya dapat mengubah BOO.md/AGENTS.md. Putaran berikutnya harus
      // langsung memakai aturan baru, bukan menunggu request pengguna berikutnya.
      if (turn > 0 && this.reloadInstructions()) {
        evidenceCache.invalidate()
        yield { type: 'instructions-reloaded', files: [...this.instructionFiles] }
      }
      const beforeTurnSteering = applySteering()
      if (beforeTurnSteering.length) yield { type: 'steering', messages: beforeTurnSteering }
      yield { type: 'turn-start', turn }
      const externalChanges = await this.fileSnapshots.changed(this.options.workspace)
      if (externalChanges.length) evidenceCache.invalidate()
      const freshnessSignature = externalChanges.map((change) => `${change.kind}:${change.path}`).join('\n')
      if (freshnessSignature !== this.lastFreshnessSignature) {
        this.lastFreshnessSignature = freshnessSignature
        if (externalChanges.length) {
          yield {
            type: 'workspace-changed',
            files: externalChanges.slice(0, MAX_FRESHNESS_NOTICE_FILES),
            remaining: Math.max(0, externalChanges.length - MAX_FRESHNESS_NOTICE_FILES),
          }
        }
      }
      const freshnessReminder = externalChanges.length ? fileFreshnessPrompt(externalChanges) : ''
      let completionReminder: string | undefined
      if (this.options.verifyCompletion !== false && mutationRevision !== verifiedRevision && lastRemindedRevision !== mutationRevision) {
        const current = await this.checkpoints.currentPlan()
        const files = current?.entries.map((entry) => entry.label) ?? []
        if (files.length) {
          lastRemindedRevision = mutationRevision
          let impact
          try {
            impact = await analyzeVerificationImpact(this.options.workspace, files, this.options.home, signal)
            latestImpact = impact
            yield {
              type: 'change-impact',
              changedFiles: impact.changedFiles.length,
              affectedFiles: impact.affectedFiles.length,
              tests: impact.directTests.length + impact.dependentTests.length,
              edges: impact.edges.length,
              maxDepth: impact.affectedFiles.reduce((maximum, file) => Math.max(maximum, file.depth), 0),
              blastRadius: impact.blastRadius,
              truncated: impact.truncated,
            }
          } catch {
            // Indeks dampak membantu memilih test, tetapi tidak boleh menghalangi
            // pengingat verifikasi dasar saat filesystem berubah di tengah scan.
          }
          completionReminder = verificationPrompt(files, verificationAttempts, impact)
          const tests = impact ? [...impact.directTests, ...impact.dependentTests] : []
          yield {
            type: 'verification-needed',
            files,
            ...(tests.length ? { tests } : {}),
            ...(impact?.commands.length ? { commands: impact.commands.map((entry) => entry.command) } : {}),
          }
        }
      }
      const verificationRepairReminder = verificationRepair.takePrompt(mutationRevision)
      let result
      const pendingToolLoopReminder = toolLoopReminder
      const pendingToolArgumentReminder = toolArgumentReminder
      const pendingToolProtocolReminder = toolProtocolReminder
      // Teks yang sudah mengalir disimpan agar tidak hilang bila dihentikan di tengah.
      const partial = { text: '' }
      try {
        const modePrompt = mode === 'review' ? REVIEW_SYSTEM_PROMPT : mode === 'plan' ? PLAN_SYSTEM_PROMPT : ''
        const injectionReminder = promptInjectionGuardPrompt(promptInjectionAssessments)
        const extraSystemPrompt = [recoveryPrompt, modePrompt, freshnessReminder, completionReminder ?? '', verificationRepairReminder, injectionReminder, pendingToolLoopReminder, pendingToolArgumentReminder, pendingToolProtocolReminder].filter(Boolean).join('\n\n') || undefined
        // Begitu benar-benar akan memanggil model, recovery sudah dipakai. Bila
        // request berhenti sebelum titik ini, catatannya tetap ada untuk berikutnya.
        if (recoveryPrompt) this.pendingRecoveryPrompt = ''
        result = yield* this.streamTurn(provider, registry, evidenceCache, signal, partial, userInput, extraSystemPrompt)
        if (toolLoopReminder === pendingToolLoopReminder) toolLoopReminder = ''
        if (toolArgumentReminder === pendingToolArgumentReminder) toolArgumentReminder = ''
        if (toolProtocolReminder === pendingToolProtocolReminder) toolProtocolReminder = ''
      } catch (error) {
        if (signal?.aborted) {
          this.settleCancellation(partial.text)
          yield { type: 'cancelled' }
          return
        }
        // Model dapat tetap muncul di /v1/models walau route upstream-nya sudah
        // hilang. Hanya Auto yang boleh berpindah sendiri, dan hanya bila 404
        // terjadi sebelum satu karakter jawaban diterima — tidak ada respons atau
        // tool yang mungkin terduplikasi.
        const capabilityFailure = error instanceof ProviderError
          ? classifyProviderCapabilityError(error, images.length > 0)
          : null
        if (this.mode === 'auto' && error instanceof ProviderError && capabilityFailure && !partial.text && autoFallbacks < 5) {
          // Model cadangan belum pernah menerima pengingat verifikasi ini.
          if (completionReminder) lastRemindedRevision = -1
          if (capabilityFailure === 'unavailable') this.autoRouter.observe({ kind: 'unavailable', model: provider.model })
          else if (capabilityFailure === 'context-limit') {
            this.autoRouter.observe({ kind: 'context-limit', model: provider.model, contextTokens: autoRequirements.contextTokens })
          } else {
            this.autoRouter.observe({
              kind: 'unsupported', model: provider.model,
              capability: capabilityFailure === 'vision-unsupported' ? 'vision'
                : capabilityFailure === 'tools-unsupported' ? 'tools' : 'reasoning',
            })
          }
          if (capabilityFailure === 'unavailable') this.autoRouter.markUnavailable(provider.model)
          else this.autoRouter.markTaskUnavailable(provider.model)
          autoFallbacks += 1
          yield { type: 'model-routing' }
          try {
            const selected = await this.autoRouter.route(provider, autoRoutingInput, this.messages.slice(1, -1), signal)
            provider.model = selected.model
            provider.reasoningEffort = selected.reasoningEffort
            this.autoSelection = selected
            yield { type: 'model-selected', ...selected }
            continue
          } catch (fallbackError) {
            const message = fallbackError instanceof Error ? fallbackError.message : 'Model cadangan Auto gagal dipilih.'
            this.settle('', `${FAILED_REPLY_PREFIX}${message})`)
            yield { type: 'error', message }
            return
          }
        }
        const message = error instanceof Error ? error.message : 'Panggilan model gagal.'
        // Riwayat tetap sah, dan model tahu jawabannya tadi tidak sampai.
        this.settle(partial.text, `${FAILED_REPLY_PREFIX}${message})`)
        yield { type: 'error', message }
        return
      }

      const message = normalizeToolCallIds(result.message, turn)
      this.append(message)
      yield { type: 'turn-end', message }

      const toolCalls = message.tool_calls ?? []
      const afterModelSteering = applySteering()
      if (afterModelSteering.length) {
        for (const call of toolCalls) this.pushToolResult(call.id, STEERING_SKIPPED_TOOL_RESULT)
        yield { type: 'steering', messages: afterModelSteering }
        continue
      }
      const finishExpectedTools = /tool|function/i.test(result.finishReason)
      if (!toolCalls.length && finishExpectedTools) {
        const decision = toolProtocolGuard.recordTurn(['empty-tool-call'], 0)
        toolProtocolReminder = toolProtocolSystemPrompt(decision)
        const handled = yield* this.handleToolProtocolDecision(decision, provider, autoRoutingInput, signal, protocolFallbacks)
        protocolFallbacks = handled.protocolFallbacks
        if (handled.switched) {
          toolProtocolGuard.reset()
          toolProtocolReminder = ''
        }
        if (handled.stop) return
        continue
      }
      if (!toolCalls.length) {
        toolProtocolGuard.reset()
        const completion = yield* this.runHooks(lifecycleHooks, 'on_complete', undefined, toolSandbox, signal, promptInjectionAssessments.some((assessment) => assessment.suspicious))
        if (completion.cancelled || signal?.aborted) {
          this.settleCancellation('')
          yield { type: 'cancelled' }
          return
        }
        const stateBeforeCompletionHook = `${mutationRevision}:${verifiedRevision}`
        if (completion.mutated) { mutationRevision += 1; latestImpact = undefined }
        if (completion.mutated) evidenceCache.invalidate()
        if (completion.verified) verifiedRevision = mutationRevision
        if (`${mutationRevision}:${verifiedRevision}` !== stateBeforeCompletionHook) {
          yield { type: 'verification-state', status: mutationRevision === verifiedRevision ? 'complete' : 'needed', revision: mutationRevision }
        }
        if (completion.failed) {
          const feedback = `${HOOK_COMPLETION_MARK}\n${completion.content}\n\nPerbaiki kegagalan hook sebelum menyimpulkan pekerjaan. Jangan abaikan pemeriksaan ini.`
          const withSteering = applySteering(feedback)
          if (withSteering.length) yield { type: 'steering', messages: withSteering }
          else this.append({ role: 'user', content: feedback })
          continue
        }
        const afterHooksSteering = applySteering()
        if (afterHooksSteering.length) {
          yield { type: 'steering', messages: afterHooksSteering }
          continue
        }
        if (this.options.verifyCompletion !== false && mutationRevision !== verifiedRevision) {
          const current = await this.checkpoints.currentPlan()
          const files = current?.entries.map((entry) => entry.label) ?? []
          if (files.length) {
            const repair = verificationRepair.onIncompleteConclusion(mutationRevision)
            if (repair.action === 'retry') {
              yield { type: 'verification-repair', stage: 'retrying', round: repair.round, maxRounds: repair.maxRounds, revision: mutationRevision }
              const feedback = verificationRepair.takePrompt(mutationRevision)
              if (feedback) this.append({ role: 'user', content: feedback })
              continue
            }
            if (repair.action === 'exhausted') {
              yield { type: 'verification-repair', stage: 'exhausted', round: repair.round, maxRounds: repair.maxRounds, revision: mutationRevision }
            }
            yield { type: 'verification-incomplete', files, attempted: verificationAttempts.length > 0 }
            return
          }
        }
        const effectiveTask = [userInput, ...appliedSteering].join('\n\n')
        const difficulty = this.autoSelection?.difficulty ?? assessLocally(effectiveTask).difficulty
        const changes = mutationRevision > 0 ? await this.checkpoints.currentChanges() : []
        const risk = assessChangeRisk(changes)
        if (mutationRevision > 0 && riskAssessedRevision !== mutationRevision) {
          riskAssessedRevision = mutationRevision
          yield { type: 'risk-assessed', assessment: risk }
        }
        const weakHighRiskVerification = risk.level === 'high' && !hasSubstantiveVerification(verificationAttempts, mutationRevision)
        if (weakHighRiskVerification && riskReminderRevision !== mutationRevision) {
          riskReminderRevision = mutationRevision
          this.append({ role: 'user', content: riskVerificationPrompt(risk.reasons) })
          continue
        }
        if (weakHighRiskVerification) yield { type: 'risk-verification-weak', assessment: risk }
        const shouldReview = this.options.autoReview !== false && mode === 'normal'
          && (difficulty === 'complex' || difficulty === 'expert' || risk.level === 'high')
          && mutationRevision > 0 && mutationRevision === verifiedRevision && reviewedRevision !== mutationRevision
        if (shouldReview) {
          if (criticRounds >= MAX_AUTO_REVIEW_ROUNDS) {
            yield { type: 'critic-end', round: criticRounds, model: provider.model, status: 'limit', findings: 0 }
            return
          }
          criticRounds += 1
          reviewedRevision = mutationRevision
          yield { type: 'critic-start', round: criticRounds }
          const review = await this.runAutomaticCritic(provider, effectiveTask, verificationAttempts, latestImpact, signal)
          if (signal?.aborted) {
            this.settleCancellation('')
            yield { type: 'cancelled' }
            return
          }
          if (!review.result) {
            yield { type: 'critic-end', round: criticRounds, model: review.model, status: 'error', findings: 0, ...(review.error ? { message: review.error } : {}) }
            const afterCriticSteering = applySteering()
            if (afterCriticSteering.length) {
              yield { type: 'steering', messages: afterCriticSteering }
              continue
            }
            return
          }
          if (review.result.verdict === 'findings') {
            yield { type: 'critic-end', round: criticRounds, model: review.model, status: 'findings', findings: review.result.findings.length }
            const feedback = criticFeedback(review.result)
            const withSteering = applySteering(feedback)
            if (withSteering.length) yield { type: 'steering', messages: withSteering }
            else this.append({ role: 'user', content: feedback })
            continue
          }
          yield { type: 'critic-end', round: criticRounds, model: review.model, status: 'pass', findings: 0 }
        }
        const beforeFinishSteering = applySteering()
        if (beforeFinishSteering.length) {
          yield { type: 'steering', messages: beforeFinishSteering }
          continue
        }
        return
      }

      const protocolFailures: ToolProtocolFailureKind[] = []
      let validProtocolCalls = 0
      for (let callIndex = 0; callIndex < toolCalls.length; callIndex += 1) {
        const call = toolCalls[callIndex]
        const beforeToolSteering = applySteering()
        if (beforeToolSteering.length) {
          for (const skipped of toolCalls.slice(callIndex)) this.pushToolResult(skipped.id, STEERING_SKIPPED_TOOL_RESULT)
          yield { type: 'steering', messages: beforeToolSteering }
          continue turnLoop
        }
        // Setelah dihentikan, tool yang tersisa tidak dijalankan tetapi tetap diberi
        // hasil — panggilan tool tanpa hasil membuat permintaan berikutnya ditolak.
        if (signal?.aborted) {
          this.pushToolResult(call.id, CANCELLED_TOOL_RESULT)
          continue
        }

        const parallelDiscovery = prepareParallelDiscovery(toolCalls, callIndex, registry, lifecycleHooks)
        if (parallelDiscovery.length) {
          validProtocolCalls += parallelDiscovery.length
          const targets = parallelDiscovery.flatMap((item) => instructionTargetsForTool(item.tool.name, item.args))
          if (targets.length && this.reloadInstructions(targets)) {
            evidenceCache.invalidate()
            yield { type: 'instructions-reloaded', files: [...this.instructionFiles] }
            for (const item of parallelDiscovery) this.pushToolResult(item.call.id, SCOPED_INSTRUCTIONS_TOOL_RESULT)
            callIndex += parallelDiscovery.length - 1
            continue
          }

          let cached = parallelDiscovery.map((item) => evidenceCache.lookup(item.tool.name, item.args))
          if (cached.some(Boolean)) {
            const lateChanges = await this.fileSnapshots.changed(this.options.workspace)
            if (lateChanges.length) {
              evidenceCache.invalidate()
              cached = parallelDiscovery.map(() => null)
              const signature = lateChanges.map((change) => `${change.kind}:${change.path}`).join('\n')
              if (signature !== this.lastFreshnessSignature) {
                this.lastFreshnessSignature = signature
                yield {
                  type: 'workspace-changed',
                  files: lateChanges.slice(0, MAX_FRESHNESS_NOTICE_FILES),
                  remaining: Math.max(0, lateChanges.length - MAX_FRESHNESS_NOTICE_FILES),
                }
              }
            }
          }

          for (const item of parallelDiscovery) {
            yield { type: 'tool-start', name: item.tool.name, preview: item.preview, callId: item.call.id, args: item.args }
          }
          const runningItems = parallelDiscovery.filter((_item, index) => !cached[index])
          const parallelTools = [...new Set(runningItems.map((item) => item.tool.name))]
          const startedAt = Date.now()
          if (runningItems.length >= 2) yield { type: 'tool-parallel', stage: 'started', name: 'discovery', tools: parallelTools, calls: runningItems.length }
          const executed = await Promise.all(runningItems.map(async (item) => {
            try {
              const outcome = await item.tool.run(item.args as never, {
                workspace: this.options.workspace,
                home: this.options.home,
                signal,
                sandbox: toolSandbox,
                fileSnapshots: this.fileSnapshots,
                toolResults,
              })
              return { callId: item.call.id, content: outcome.content, isError: Boolean(outcome.isError) }
            } catch (error) {
              return { callId: item.call.id, content: `Gagal: ${error instanceof Error ? error.message : 'error tak dikenal'}`, isError: true }
            }
          }))
          const durationMs = Math.max(0, Date.now() - startedAt)
          if (runningItems.length >= 2) yield { type: 'tool-parallel', stage: 'completed', name: 'discovery', tools: parallelTools, calls: runningItems.length, durationMs }
          const byCall = new Map(executed.map((outcome) => [outcome.callId, outcome]))

          for (let index = 0; index < parallelDiscovery.length; index += 1) {
            const item = parallelDiscovery[index]
            const cacheHit = cached[index] as EvidenceCacheHit | null
            const outcome = cacheHit
              ? { content: cacheHit.content, isError: false }
              : byCall.get(item.call.id)!
            if (cacheHit) {
              yield { type: 'tool-cache-hit', name: item.tool.name, callId: item.call.id, ref: cacheHit.ref, savedCharacters: cacheHit.savedCharacters }
            } else {
              const injection = assessPromptInjection(item.tool.name, outcome.content)
              if (injection?.suspicious) {
                promptInjectionAssessments.push(injection)
                yield { type: 'prompt-injection-detected', tool: item.tool.name, source: injection.source, categories: injection.categories }
              }
              if (!outcome.isError && !signal?.aborted) evidenceCache.store(item.tool.name, item.args, item.call.id, item.preview, outcome.content)
            }
            const presented = toolResults.present(item.tool.name, item.call.id, outcome.content)
            if (presented.truncated) {
              yield {
                type: 'tool-result-truncated', name: item.tool.name, callId: item.call.id,
                ...(presented.ref ? { ref: presented.ref } : {}),
                originalCharacters: presented.originalCharacters, visibleCharacters: presented.visibleCharacters,
              }
            }
            yield {
              type: 'tool-end', name: item.tool.name, callId: item.call.id, content: presented.content,
              isError: outcome.isError, cancelled: Boolean(signal?.aborted),
            }
            this.pushToolResult(item.call.id, presented.content)
          }
          callIndex += parallelDiscovery.length - 1
          continue
        }

        const tool = registry.get(call.function.name)
        if (!tool) {
          const name = toolProtocolName(call.function.name)
          const issues = ['$: nama tool tidak ada di katalog runtime']
          protocolFailures.push('unknown-tool')
          yield { type: 'tool-invalid', name, callId: call.id, kind: 'unknown', issues }
          this.pushToolResult(call.id, unknownToolFailure(call.function.name))
          continue
        }

        let parsed: unknown
        try {
          parsed = JSON.parse(call.function.arguments || '{}')
        } catch {
          const issues = ['$: harus berupa objek JSON yang valid']
          protocolFailures.push('invalid-json')
          toolArgumentReminder = toolArgumentSystemPrompt(tool.name, issues)
          yield { type: 'tool-invalid', name: tool.name, callId: call.id, kind: 'json', issues }
          this.pushToolResult(call.id, toolArgumentFailure(tool.name, issues))
          continue
        }
        const issues = validateToolArguments(tool.schema.function.parameters, parsed)
        if (issues.length) {
          protocolFailures.push('invalid-schema')
          toolArgumentReminder = toolArgumentSystemPrompt(tool.name, issues)
          yield { type: 'tool-invalid', name: tool.name, callId: call.id, kind: 'schema', issues }
          this.pushToolResult(call.id, toolArgumentFailure(tool.name, issues))
          continue
        }
        const args = parsed as Record<string, unknown>
        validProtocolCalls += 1

        const instructionTargets = instructionTargetsForTool(tool.name, args)
        if (instructionTargets.length && this.reloadInstructions(instructionTargets)) {
          evidenceCache.invalidate()
          yield { type: 'instructions-reloaded', files: [...this.instructionFiles] }
          this.pushToolResult(call.id, SCOPED_INSTRUCTIONS_TOOL_RESULT)
          continue
        }

        let preview: string
        try {
          preview = tool.preview(args as never)
        } catch {
          const previewIssues = ['$: pratinjau tool gagal setelah validasi; tool tidak dijalankan']
          toolArgumentReminder = toolArgumentSystemPrompt(tool.name, previewIssues)
          yield { type: 'tool-invalid', name: tool.name, callId: call.id, kind: 'preview', issues: previewIssues }
          this.pushToolResult(call.id, toolArgumentFailure(tool.name, previewIssues))
          continue
        }
        const hasLifecycleHooks = lifecycleHooks.some((hook) => hookMatches(hook, 'before_tool', tool.name) || hookMatches(hook, 'after_tool', tool.name))
        let cached = !hasLifecycleHooks ? evidenceCache.lookup(tool.name, args) : null
        if (cached) {
          // Menutup race bila editor mengubah file setelah pemeriksaan awal turn,
          // tetapi sebelum model mengulangi read_file.
          const lateChanges = await this.fileSnapshots.changed(this.options.workspace)
          if (lateChanges.length) {
            evidenceCache.invalidate()
            cached = null
            const signature = lateChanges.map((change) => `${change.kind}:${change.path}`).join('\n')
            if (signature !== this.lastFreshnessSignature) {
              this.lastFreshnessSignature = signature
              yield {
                type: 'workspace-changed',
                files: lateChanges.slice(0, MAX_FRESHNESS_NOTICE_FILES),
                remaining: Math.max(0, lateChanges.length - MAX_FRESHNESS_NOTICE_FILES),
              }
            }
          }
        }
        if (cached) {
          yield { type: 'tool-start', name: tool.name, preview: cached.preview, callId: call.id, args }
          yield { type: 'tool-cache-hit', name: tool.name, callId: call.id, ref: cached.ref, savedCharacters: cached.savedCharacters }
          yield { type: 'tool-end', name: tool.name, callId: call.id, content: cached.content, isError: false, cancelled: false }
          this.pushToolResult(call.id, cached.content)
          continue
        }

        const loop = toolLoopGuard.inspect(tool.name, args)
        if (loop.action === 'blocked') {
          toolLoopReminder = toolLoopSystemPrompt(tool.name, 'blocked')
          yield { type: 'tool-loop', name: tool.name, stage: 'blocked', repetitions: loop.repetitions }
          this.pushToolResult(call.id, TOOL_LOOP_BLOCKED_RESULT)
          continue
        }
        if (loop.action === 'stopped') {
          yield { type: 'tool-loop', name: tool.name, stage: 'stopped', repetitions: loop.repetitions }
          for (const skipped of toolCalls.slice(callIndex)) this.pushToolResult(skipped.id, TOOL_LOOP_STOPPED_RESULT)
          this.append({ role: 'assistant', content: TOOL_LOOP_STOPPED_REPLY })
          return
        }
        const loopToken = loop.token
        if (this.options.sandbox?.mode === 'read-only' && tool.writesWorkspace) {
          let content = `Diblokir: mode sandbox read-only tidak mengizinkan ${tool.name} mengubah workspace.`
          if (toolLoopGuard.record(loopToken, content, 'failed')) {
            toolLoopReminder = toolLoopSystemPrompt(tool.name, 'warning')
            yield { type: 'tool-loop', name: tool.name, stage: 'warning', repetitions: 2 }
            content = `${content}\n\n${toolLoopWarning(tool.name)}`
          }
          yield { type: 'tool-start', name: tool.name, preview, callId: call.id, args }
          yield { type: 'tool-end', name: tool.name, callId: call.id, content, isError: true, cancelled: false }
          this.pushToolResult(call.id, content)
          continue
        }
        if (tool.risk === 'confirm') {
          // Pratinjau gagal bukan alasan membatalkan; izin tetap diminta,
          // hanya saja tanpa diff.
          let detail: DiffLine[] | null
          try {
            detail = await tool.detail?.(args as never, {
              workspace: this.options.workspace,
              home: this.options.home,
              fileSnapshots: this.fileSnapshots,
              sandbox: toolSandbox,
            }) ?? null
          } catch {
            detail = null
          }
          const promptInjectionRisk = promptInjectionAssessments.some((assessment) => assessment.suspicious)
          const answer = await this.options.askPermission({
            name: tool.name,
            preview,
            args,
            allowAlways: tool.allowAlways !== false && !promptInjectionRisk,
            ...(promptInjectionRisk ? { promptInjectionRisk: true } : {}),
            detail,
          })
          if (signal?.aborted) {
            this.pushToolResult(call.id, CANCELLED_TOOL_RESULT)
            continue
          }
          const decision = typeof answer === 'boolean' ? { allowed: answer } : answer
          if (!decision.allowed) {
            const feedback = decision.feedback?.trim()
            yield { type: 'tool-denied', name: tool.name, callId: call.id, ...(feedback ? { feedback } : {}) }
            let denied = feedback
              ? `Ditolak oleh pengguna, dengan arahan: ${feedback}\nIkuti arahan itu; jangan ulangi tindakan yang ditolak tanpa perubahan.`
              : 'Ditolak oleh pengguna. Jangan ulangi; tanyakan langkah berikutnya.'
            if (toolLoopGuard.record(loopToken, denied, 'denied')) {
              toolLoopReminder = toolLoopSystemPrompt(tool.name, 'denied')
              yield { type: 'tool-loop', name: tool.name, stage: 'warning', repetitions: 1 }
              denied = `${denied}\n\n${toolLoopDeniedWarning(tool.name)}`
            }
            this.pushToolResult(call.id, denied)
            continue
          }
        }

        const beforeHooks = yield* this.runHooks(lifecycleHooks, 'before_tool', tool.name, toolSandbox, signal, promptInjectionAssessments.some((assessment) => assessment.suspicious))
        if (beforeHooks.cancelled || signal?.aborted) {
          this.pushToolResult(call.id, CANCELLED_TOOL_RESULT)
          continue
        }
        const stateBeforeBeforeHook = `${mutationRevision}:${verifiedRevision}`
        if (beforeHooks.mutated) { mutationRevision += 1; latestImpact = undefined }
        if (beforeHooks.mutated) evidenceCache.invalidate()
        if (beforeHooks.verified) verifiedRevision = mutationRevision
        if (`${mutationRevision}:${verifiedRevision}` !== stateBeforeBeforeHook) {
          yield { type: 'verification-state', status: mutationRevision === verifiedRevision ? 'complete' : 'needed', revision: mutationRevision }
        }
        if (beforeHooks.failed || beforeHooks.denied) {
          let content = `Diblokir lifecycle hook before_tool untuk ${tool.name}.\n${beforeHooks.content}`
          if (toolLoopGuard.record(loopToken, content, 'failed')) {
            toolLoopReminder = toolLoopSystemPrompt(tool.name, 'warning')
            yield { type: 'tool-loop', name: tool.name, stage: 'warning', repetitions: 2 }
            content = `${content}\n\n${toolLoopWarning(tool.name)}`
          }
          yield { type: 'tool-start', name: tool.name, preview, callId: call.id, args }
          yield { type: 'tool-end', name: tool.name, callId: call.id, content, isError: true, cancelled: false }
          this.pushToolResult(call.id, content)
          continue
        }

        yield { type: 'tool-start', name: tool.name, preview, callId: call.id, args }
        let content: string
        let isError: boolean
        let recovery: ToolRecovery | undefined
        let lspSession: { reused: boolean; restarted: boolean; openDocuments: number } | undefined
        // Keluaran dari callback ditampung lalu diteruskan sebagai event selagi tool
        // berjalan; generator tidak bisa yield dari dalam callback.
        const chunks: string[] = []
        let wake: (() => void) | null = null
        let settled = false
        if (tool.runsCommand || tool.writesWorkspace || tool.mutatesWorkspace) evidenceCache.invalidate()
        if (tool.runsCommand) this.checkpoints.noteCommand()
        const running = tool.run(args as never, {
          workspace: this.options.workspace,
          home: this.options.home,
          signal,
          checkpoint: this.checkpoints,
          sandbox: toolSandbox,
          fileSnapshots: this.fileSnapshots,
          delegate: (task, maxSubagentTurns) => this.runDelegatedTask(task, maxSubagentTurns, signal, (chunk) => {
            chunks.push(chunk)
            wake?.()
          }),
          delegateWrite: (tasks, maxSubagentTurns) => this.runWritableDelegatedTasks(tasks, maxSubagentTurns, signal, (chunk) => {
            chunks.push(chunk)
            wake?.()
          }),
          askUser: this.options.askUser,
          toolResults,
          onOutput: (chunk) => {
            chunks.push(chunk)
            wake?.()
          },
        })
        running.then(() => undefined, () => undefined).finally(() => {
          settled = true
          wake?.()
        })
        for (;;) {
          if (chunks.length) {
            yield { type: 'tool-output', name: tool.name, callId: call.id, chunk: chunks.splice(0).join('') }
            continue
          }
          if (settled) break
          await new Promise<void>((resolve) => {
            // Diperiksa ulang di dalam executor, yang berjalan sinkron: keluaran atau
            // selesainya tool di antara pemeriksaan di atas tidak boleh terlewat.
            if (settled || chunks.length) resolve()
            else wake = resolve
          })
          wake = null
        }
        try {
          const outcome = await running
          content = outcome.content
          isError = Boolean(outcome.isError)
          recovery = outcome.recovery
          lspSession = outcome.lspSession
        } catch (error) {
          content = `Gagal: ${error instanceof Error ? error.message : 'error tak dikenal'}`
          isError = true
        }
        if (recovery) yield { type: 'tool-recovery', name: tool.name, callId: call.id, ...recovery }
        if (lspSession) yield { type: 'lsp-session', stage: lspSession.restarted ? 'restarted' : lspSession.reused ? 'reused' : 'started', openDocuments: lspSession.openDocuments }
        const injection = assessPromptInjection(tool.name, content)
        if (injection?.suspicious) {
          promptInjectionAssessments.push(injection)
          yield { type: 'prompt-injection-detected', tool: tool.name, source: injection.source, categories: injection.categories }
        }
        const stateBeforeTool = `${mutationRevision}:${verifiedRevision}`
        if (!isError && tool.mutatesWorkspace) { mutationRevision += 1; latestImpact = undefined }
        if ((tool.name === 'bash' && isVerificationCommand(args.command)) || tool.verifiesWorkspace) {
          const command = tool.verifiesWorkspace ? tool.name : String(args.command)
          verificationAttempts.push({ command, success: !isError, revision: mutationRevision, strength: tool.verifiesWorkspace ? 'substantive' : verificationStrength(command) })
          if (isError && mutationRevision > 0 && mutationRevision !== verifiedRevision) {
            const repair = verificationRepair.recordFailure(command, mutationRevision)
            yield { type: 'verification-repair', stage: 'needed', round: repair.round, maxRounds: MAX_VERIFICATION_REPAIR_ROUNDS, revision: mutationRevision }
          } else {
            if (!isError) {
              verifiedRevision = mutationRevision
              const repairedRounds = verificationRepair.recordSuccess()
              if (repairedRounds) yield { type: 'verification-repair', stage: 'repaired', round: repairedRounds, maxRounds: MAX_VERIFICATION_REPAIR_ROUNDS, revision: mutationRevision }
            }
          }
        }
        if (`${mutationRevision}:${verifiedRevision}` !== stateBeforeTool) {
          yield { type: 'verification-state', status: mutationRevision === verifiedRevision ? 'complete' : 'needed', revision: mutationRevision }
        }
        const afterHooks = yield* this.runHooks(lifecycleHooks, 'after_tool', tool.name, toolSandbox, signal, promptInjectionAssessments.some((assessment) => assessment.suspicious))
        const stateBeforeAfterHook = `${mutationRevision}:${verifiedRevision}`
        if (afterHooks.mutated) { mutationRevision += 1; latestImpact = undefined }
        if (afterHooks.mutated) evidenceCache.invalidate()
        if (afterHooks.verified) verifiedRevision = mutationRevision
        if (`${mutationRevision}:${verifiedRevision}` !== stateBeforeAfterHook) {
          yield { type: 'verification-state', status: mutationRevision === verifiedRevision ? 'complete' : 'needed', revision: mutationRevision }
        }
        if (afterHooks.content) content = `${content}\n\nLifecycle hooks after_tool:\n${afterHooks.content}`
        if (afterHooks.failed) isError = true
        if (toolLoopGuard.record(loopToken, content, isError ? 'failed' : 'completed')) {
          toolLoopReminder = toolLoopSystemPrompt(tool.name, 'warning')
          yield { type: 'tool-loop', name: tool.name, stage: 'warning', repetitions: 2 }
          content = `${content}\n\n${toolLoopWarning(tool.name)}`
        }
        if (!isError && !signal?.aborted && !afterHooks.mutated && !hasLifecycleHooks) {
          evidenceCache.store(tool.name, args, call.id, preview, content)
        }
        const presented = toolResults.present(tool.name, call.id, content)
        if (presented.truncated) {
          yield {
            type: 'tool-result-truncated', name: tool.name, callId: call.id,
            ...(presented.ref ? { ref: presented.ref } : {}),
            originalCharacters: presented.originalCharacters, visibleCharacters: presented.visibleCharacters,
          }
        }
        // Tool yang terhenti karena pembatalan bukan kegagalan yang perlu dilaporkan.
        yield { type: 'tool-end', name: tool.name, callId: call.id, content: presented.content, isError, cancelled: Boolean(signal?.aborted) }
        this.pushToolResult(call.id, presented.content)
      }

      if (signal?.aborted) {
        this.settleCancellation('')
        yield { type: 'cancelled' }
        return
      }
      const protocolDecision = toolProtocolGuard.recordTurn(protocolFailures, validProtocolCalls)
      if (protocolFailures.length && validProtocolCalls === 0) toolProtocolReminder = toolProtocolSystemPrompt(protocolDecision)
      const handled = yield* this.handleToolProtocolDecision(protocolDecision, provider, autoRoutingInput, signal, protocolFallbacks)
      protocolFallbacks = handled.protocolFallbacks
      if (handled.switched) {
        toolProtocolGuard.reset()
        toolProtocolReminder = ''
      }
      if (handled.stop) return
      const afterToolsSteering = applySteering()
      if (afterToolsSteering.length) yield { type: 'steering', messages: afterToolsSteering }
    }
  }

  /** Membuka circuit secara aman; hanya Auto yang boleh mengganti model sendiri. */
  private async *handleToolProtocolDecision(
    decision: ToolProtocolDecision,
    provider: NineRouterProvider,
    routingInput: string,
    signal: AbortSignal | undefined,
    protocolFallbacks: number,
  ): AsyncGenerator<AgentEvent, { protocolFallbacks: number; switched: boolean; stop: boolean }> {
    if (decision.action === 'continue') return { protocolFallbacks, switched: false, stop: false }
    if (decision.action === 'warning') {
      yield {
        type: 'tool-protocol', stage: 'warning', model: provider.model,
        consecutiveTurns: decision.consecutiveTurns, failures: decision.failures, kinds: decision.kinds,
      }
      return { protocolFallbacks, switched: false, stop: false }
    }

    if (this.mode === 'auto' && protocolFallbacks < MAX_TOOL_PROTOCOL_AUTO_FALLBACKS && !signal?.aborted) {
      const failedModel = provider.model
      yield {
        type: 'tool-protocol', stage: 'fallback', model: failedModel,
        consecutiveTurns: decision.consecutiveTurns, failures: decision.failures, kinds: decision.kinds,
      }
      this.autoRouter.markUnavailable(failedModel)
      this.autoRouter.observe({ kind: 'tool-protocol-failure', model: failedModel })
      yield { type: 'model-routing' }
      try {
        const selected = await this.autoRouter.route(provider, routingInput, this.messages.slice(1), signal)
        const fallback = {
          ...selected,
          reason: `${selected.reason} Beralih karena ${failedModel} berulang kali menghasilkan function call yang tidak valid.`,
        }
        provider.model = fallback.model
        provider.reasoningEffort = fallback.reasoningEffort
        this.autoSelection = fallback
        yield { type: 'model-selected', ...fallback }
        return { protocolFallbacks: protocolFallbacks + 1, switched: true, stop: false }
      } catch (error) {
        if (signal?.aborted) {
          this.settleCancellation('')
          yield { type: 'cancelled' }
        } else {
          const message = error instanceof Error ? error.message : 'Model cadangan Auto gagal dipilih setelah circuit function-calling terbuka.'
          this.settle('', `${FAILED_REPLY_PREFIX}${message})`)
          yield { type: 'error', message }
        }
        return { protocolFallbacks, switched: false, stop: true }
      }
    }

    yield {
      type: 'tool-protocol', stage: 'stopped', model: provider.model,
      consecutiveTurns: decision.consecutiveTurns, failures: decision.failures, kinds: decision.kinds,
    }
    this.append({ role: 'assistant', content: TOOL_PROTOCOL_STOPPED_REPLY })
    return { protocolFallbacks, switched: false, stop: true }
  }

  /**
   * Merapikan riwayat setelah pengguna menghentikan pekerjaan, di titik mana pun.
   *
   * Riwayat harus tetap sah untuk permintaan berikutnya: setiap panggilan tool punya
   * hasil, dan giliran terakhir milik assistant. Tanpa itu, pertanyaan berikutnya
   * akan ditolak model — pertanyaan baru tepat setelah pesan user atau hasil tool.
   * Teks jawaban yang sudah terlanjur tampil disimpan beserta tanda dibatalkan.
   */
  private settleCancellation(partialText: string): void {
    this.settle(partialText, CANCELLED_REPLY)
  }

  /** Melengkapi hasil tool yang hilang dan menutup giliran dengan tanda `marker`. */
  private settle(partialText: string, marker: string): void {
    const lastAssistant = [...this.messages].reverse().find((message) => message.role === 'assistant')
    for (const call of lastAssistant?.tool_calls ?? []) {
      const answered = this.messages.some((message) => message.role === 'tool' && message.tool_call_id === call.id)
      if (!answered) this.pushToolResult(call.id, CANCELLED_TOOL_RESULT)
    }
    const last = this.messages.at(-1)
    if (last?.role === 'assistant' && !last.tool_calls?.length) return
    const text = partialText.trim()
    this.append({ role: 'assistant', content: text ? `${text}\n\n${marker}` : marker })
  }

  /** Meneruskan event streaming dan mengulang sekali bila balasannya kosong. */
  private async *streamTurn(
    provider: NineRouterProvider,
    registry: ToolRegistry,
    evidenceCache: EvidenceCache,
    signal: AbortSignal | undefined,
    partial: { text: string },
    focus: string,
    extraSystemPrompt?: string,
  ) {
    const schemas = registry.schemas()
    const maxContextTokens = this.options.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS
    const schemaTokens = estimateToolSchemaTokens(schemas)
    if (!signal?.aborted) yield* this.compactIfNeeded(signal, schemas)
    for (let attempt = 0; ; attempt += 1) {
      // Riwayat penuh tetap disimpan; yang dipangkas hanya salinan yang dikirim.
      const context = this.contextMessages(extraSystemPrompt)
      const latestUserFocus = [...context].reverse().find((message) => message.role === 'user' && message.content?.trim())?.content ?? ''
      const relevanceFocus = `${latestUserFocus.slice(0, 20_000)}\n${focus}`
      let trimmed = trimToBudget(
        protectToolResultMessages(context),
        messageContextBudget(maxContextTokens, schemas),
        { focus: relevanceFocus },
      )
      // Hydrasi dilakukan sesudah trimming. Bila hasil sumber masih ada, reference
      // tetap kecil; bila sumber terpotong, hasil penuh dipulihkan lalu di-trim lagi.
      for (let hydration = 0; hydration < 3; hydration += 1) {
        const restored = evidenceCache.hydrateReferences(trimmed.messages)
        if (!restored.hydrated) break
        trimmed = trimToBudget(restored.messages, messageContextBudget(maxContextTokens, schemas), { focus: relevanceFocus })
      }
      if (trimmed.droppedMessages && attempt === 0) {
        yield {
          type: 'context-trimmed',
          droppedMessages: trimmed.droppedMessages,
          estimatedTokens: trimmed.estimatedTokens + schemaTokens,
          prioritizedMessages: trimmed.prioritizedMessages,
          dependencyMessages: trimmed.dependencyMessages,
          dependencyEdges: trimmed.dependencyEdges,
        } as AgentEvent
      }
      const delays = this.options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS
      let result
      for (let retry = 0; ; retry += 1) {
        const stream = provider.stream(trimmed.messages, schemas, signal)
        partial.text = ''
        try {
          let next = await stream.next()
          while (!next.done) {
            if (next.value.type === 'text') partial.text += next.value.delta
            yield next.value as AgentEvent
            next = await stream.next()
          }
          result = next.value
          break
        } catch (error) {
          const transient = error instanceof ProviderError && error.retryable
          if (!transient || retry >= delays.length || signal?.aborted) throw error
          // Jeda dari 9Router dihormati, ditambah sedikit agar tidak tepat di batasnya.
          const delayMs = error.retryAfterMs !== undefined ? error.retryAfterMs + 500 : delays[retry]
          yield { type: 'retry', attempt: retry + 1, maxAttempts: delays.length, delayMs, message: error.message } as AgentEvent
          await sleep(delayMs, signal)
          if (signal?.aborted) throw error
        }
      }

      const empty = !result.message.content?.trim() && !result.message.tool_calls?.length
      if (!empty || attempt >= EMPTY_REPLY_RETRIES || signal?.aborted) {
        if (!empty && this.mode === 'auto') {
          this.autoRouter.observe({
            kind: 'response',
            model: provider.model,
            tools: schemas.length > 0,
            vision: trimmed.messages.some((message) => Boolean(message.images?.length)),
            reasoning: Boolean(provider.reasoningEffort),
            contextTokens: trimmed.estimatedTokens + schemaTokens,
          })
        }
        return result
      }
    }
  }

  private pushToolResult(callId: string, content: string): void {
    this.append({ role: 'tool', tool_call_id: callId, content })
  }

  /** Satu-satunya jalan pesan baru masuk ke riwayat, agar selalu terlaporkan. */
  private append(message: Message): void {
    this.messages.push(message)
    this.options.onMessage?.(message)
  }
}
