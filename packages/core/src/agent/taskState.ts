/** Potret task aktif/terakhir yang dapat diperiksa tanpa memanggil model. */

import { splitUndoNote } from './checkpoints.ts'
import { promptCommandTitle } from './commands.ts'
import { IMPLEMENT_PLAN_PROMPT_MARK, planPromptTitle } from './planning.ts'
import { referencedPromptTitle } from './references.ts'
import { steeringPromptTitle } from './steering.ts'
import type { AgentEvent } from './loop.ts'
import type { Message } from '../domain/message.ts'
import { latestTodos, parseTodos, type TodoItem } from '../tools/todo.ts'

export type TaskOutcome = 'idle' | 'unknown' | 'running' | 'completed' | 'incomplete' | 'cancelled' | 'stopped' | 'error'
export type TaskVerification = 'unknown' | 'not-required' | 'needed' | 'complete' | 'incomplete'

export interface TaskToolStats {
  started: number
  completed: number
  failed: number
  cancelled: number
  denied: number
  invalid: number
}

export interface TaskStateSnapshot {
  objective: string | null
  outcome: TaskOutcome
  startedAt: number | null
  finishedAt: number | null
  elapsedMs: number
  turns: number
  model: string | null
  reasoningEffort: string | null
  todos: TodoItem[]
  activeTools: string[]
  tools: TaskToolStats
  affectedFiles: string[]
  ranCommands: boolean
  verification: TaskVerification
  promptInjectionDetected: boolean
  criticReviews: number
  criticFindings: number
  loopWarnings: number
  loopBlocks: number
  protocolWarnings: number
  protocolFallbacks: number
  protocolStops: number
  evidenceCacheHits: number
  evidenceCacheSavedCharacters: number
  contextPrioritizedMessages: number
  parallelDiscoveryBatches: number
  parallelDiscoveryCalls: number
  truncatedToolResults: number
  deferredToolResultCharacters: number
}

const INTERNAL_USER_MARKS = [
  '[AUTOMATIC CRITIC FEEDBACK]',
  '[Boo on_complete hook feedback]',
  '[CHANGE RISK VERIFICATION]',
]

function bounded(value: string, maximum = 500): string {
  const normalized = Array.from(value, (character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127 ? '' : character
  }).join('').replace(/\s+/g, ' ').trim()
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum - 1)}…`
}

/** Tujuan user terbaru; feedback otomatis internal tidak dianggap task baru. */
export function taskObjective(messages: readonly Message[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== 'user' || !message.content?.trim()) continue
    const raw = splitUndoNote(message.content).text
    const steering = steeringPromptTitle(raw)
    if (steering) return bounded(steering)
    if (INTERNAL_USER_MARKS.some((mark) => raw.startsWith(mark))) continue
    const plan = planPromptTitle(raw)
    if (plan) return bounded(plan)
    const visible = promptCommandTitle(raw) ?? referencedPromptTitle(raw) ?? raw
    if (visible.startsWith(`${IMPLEMENT_PLAN_PROMPT_MARK}\n`)) {
      const original = /\nOriginal task:\n([\s\S]*?)\n\nPlan:\n/.exec(visible)?.[1]
      if (original?.trim()) return bounded(original)
    }
    const objective = bounded(visible)
    if (objective) return objective
  }
  return null
}

/** State machine kecil; seluruh isinya berasal dari event lokal, bukan model tambahan. */
export class TaskStateTracker {
  private objective: string | null
  private outcome: TaskOutcome
  private startedAt: number | null = null
  private finishedAt: number | null = null
  private turns = 0
  private model: string | null
  private reasoningEffort: string | null
  private todos: TodoItem[]
  private readonly active = new Map<string, string>()
  private tools: TaskToolStats = { started: 0, completed: 0, failed: 0, cancelled: 0, denied: 0, invalid: 0 }
  private readonly files = new Set<string>()
  private ranCommands = false
  private verification: TaskVerification = 'unknown'
  private promptInjectionDetected = false
  private criticReviews = 0
  private criticFindings = 0
  private loopWarnings = 0
  private loopBlocks = 0
  private protocolWarnings = 0
  private protocolFallbacks = 0
  private protocolStops = 0
  private evidenceCacheHits = 0
  private evidenceCacheSavedCharacters = 0
  private contextPrioritizedMessages = 0
  private parallelDiscoveryBatches = 0
  private parallelDiscoveryCalls = 0
  private truncatedToolResults = 0
  private deferredToolResultCharacters = 0

  constructor(history: readonly Message[] = [], model?: string, reasoningEffort?: string) {
    this.objective = taskObjective(history)
    this.outcome = this.objective ? 'unknown' : 'idle'
    this.model = model ?? null
    this.reasoningEffort = reasoningEffort ?? null
    this.todos = latestTodos(history)
  }

  begin(prompt: string, model?: string, reasoningEffort?: string, now = Date.now()): void {
    this.objective = taskObjective([{ role: 'user', content: prompt }])
    this.outcome = 'running'
    this.startedAt = now
    this.finishedAt = null
    this.turns = 0
    this.model = model ?? this.model
    this.reasoningEffort = reasoningEffort ?? null
    this.todos = []
    this.active.clear()
    this.tools = { started: 0, completed: 0, failed: 0, cancelled: 0, denied: 0, invalid: 0 }
    this.files.clear()
    this.ranCommands = false
    this.verification = 'not-required'
    this.promptInjectionDetected = false
    this.criticReviews = 0
    this.criticFindings = 0
    this.loopWarnings = 0
    this.loopBlocks = 0
    this.protocolWarnings = 0
    this.protocolFallbacks = 0
    this.protocolStops = 0
    this.evidenceCacheHits = 0
    this.evidenceCacheSavedCharacters = 0
    this.contextPrioritizedMessages = 0
    this.parallelDiscoveryBatches = 0
    this.parallelDiscoveryCalls = 0
    this.truncatedToolResults = 0
    this.deferredToolResultCharacters = 0
  }

  record(event: AgentEvent): void {
    switch (event.type) {
      case 'model-selected':
        this.model = event.model
        this.reasoningEffort = event.reasoningEffort ?? null
        break
      case 'turn-start':
        this.turns = Math.max(this.turns, event.turn + 1)
        break
      case 'tool-start': {
        this.active.set(event.callId, event.name)
        this.tools.started += 1
        if (event.name === 'todo_write') {
          const parsed = parseTodos(event.args.todos)
          if (typeof parsed !== 'string') this.todos = parsed
        }
        if (event.name === 'bash' || event.name === 'diagnostics') this.ranCommands = true
        break
      }
      case 'tool-end':
        this.active.delete(event.callId)
        if (event.cancelled) this.tools.cancelled += 1
        else if (event.isError) this.tools.failed += 1
        else this.tools.completed += 1
        break
      case 'tool-cache-hit':
        this.evidenceCacheHits += 1
        this.evidenceCacheSavedCharacters += event.savedCharacters
        break
      case 'context-trimmed':
        this.contextPrioritizedMessages += event.prioritizedMessages
        break
      case 'tool-parallel':
        if (event.stage === 'started') {
          this.parallelDiscoveryBatches += 1
          this.parallelDiscoveryCalls += event.calls
        }
        break
      case 'tool-result-truncated':
        this.truncatedToolResults += 1
        this.deferredToolResultCharacters += Math.max(0, event.originalCharacters - event.visibleCharacters)
        break
      case 'tool-denied':
        this.active.delete(event.callId)
        this.tools.denied += 1
        break
      case 'tool-invalid':
        this.active.delete(event.callId)
        this.tools.invalid += 1
        break
      case 'tool-loop':
        if (event.stage === 'warning') this.loopWarnings += 1
        else this.loopBlocks += 1
        if (event.stage === 'stopped') this.outcome = 'incomplete'
        break
      case 'tool-protocol':
        if (event.stage === 'warning') this.protocolWarnings += 1
        else if (event.stage === 'fallback') this.protocolFallbacks += 1
        else {
          this.protocolStops += 1
          this.outcome = 'stopped'
        }
        break
      case 'verification-state':
        this.verification = event.status
        break
      case 'verification-needed':
        event.files.forEach((file) => this.files.add(file))
        this.verification = 'needed'
        break
      case 'verification-incomplete':
        event.files.forEach((file) => this.files.add(file))
        this.verification = 'incomplete'
        this.outcome = 'incomplete'
        break
      case 'prompt-injection-detected':
        this.promptInjectionDetected = true
        break
      case 'critic-start':
        this.criticReviews += 1
        break
      case 'critic-end':
        this.criticFindings += event.findings
        break
      case 'cancelled': this.outcome = 'cancelled'; break
      case 'turn-limit': this.outcome = 'stopped'; break
      case 'error': this.outcome = 'error'; break
      default: break
    }
  }

  finish(clean: boolean, now = Date.now(), interrupted: 'stopped' | 'error' = 'error'): void {
    this.finishedAt = now
    if (clean) this.active.clear()
    if (!clean && this.outcome === 'running') this.outcome = interrupted
    else if (this.outcome === 'running') this.outcome = 'completed'
  }

  snapshot(now = Date.now(), workspace?: { files?: readonly string[]; ranCommands?: boolean }): TaskStateSnapshot {
    const files = new Set(this.files)
    workspace?.files?.forEach((file) => files.add(file))
    const end = this.finishedAt ?? now
    return {
      objective: this.objective,
      outcome: this.outcome,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      elapsedMs: this.startedAt === null ? 0 : Math.max(0, end - this.startedAt),
      turns: this.turns,
      model: this.model,
      reasoningEffort: this.reasoningEffort,
      todos: this.todos.map((todo) => ({ ...todo })),
      activeTools: [...new Set(this.active.values())],
      tools: { ...this.tools },
      affectedFiles: [...files].sort(),
      ranCommands: this.ranCommands || Boolean(workspace?.ranCommands),
      verification: this.verification,
      promptInjectionDetected: this.promptInjectionDetected,
      criticReviews: this.criticReviews,
      criticFindings: this.criticFindings,
      loopWarnings: this.loopWarnings,
      loopBlocks: this.loopBlocks,
      protocolWarnings: this.protocolWarnings,
      protocolFallbacks: this.protocolFallbacks,
      protocolStops: this.protocolStops,
      evidenceCacheHits: this.evidenceCacheHits,
      evidenceCacheSavedCharacters: this.evidenceCacheSavedCharacters,
      contextPrioritizedMessages: this.contextPrioritizedMessages,
      parallelDiscoveryBatches: this.parallelDiscoveryBatches,
      parallelDiscoveryCalls: this.parallelDiscoveryCalls,
      truncatedToolResults: this.truncatedToolResults,
      deferredToolResultCharacters: this.deferredToolResultCharacters,
    }
  }
}

function duration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)}s`
  const minutes = Math.floor(ms / 60_000)
  return `${minutes}m ${Math.floor(ms % 60_000 / 1_000)}s`
}

/** Teks netral yang sama untuk CLI dan web. */
export function formatTaskStatus(state: TaskStateSnapshot): string {
  if (!state.objective && state.outcome === 'idle') return 'Belum ada task pada sesi ini.'
  const done = state.todos.filter((todo) => todo.status === 'completed').length
  const current = state.todos.find((todo) => todo.status === 'in_progress')?.content
  const outcome = {
    idle: 'belum ada task', unknown: 'status sebelumnya tidak direkam', running: 'sedang berjalan', completed: 'selesai',
    incomplete: 'belum tuntas', cancelled: 'dibatalkan', stopped: 'dihentikan', error: 'gagal',
  }[state.outcome]
  const verification = {
    unknown: 'tidak diketahui', 'not-required': 'belum diperlukan', needed: 'diperlukan', complete: 'selesai', incomplete: 'belum tuntas',
  }[state.verification]
  return [
    `Task · ${outcome}${state.elapsedMs ? ` · ${duration(state.elapsedMs)}` : ''}`,
    state.objective ? `Tujuan: ${state.objective}` : '',
    state.model ? `Model: ${state.model}${state.reasoningEffort ? ` · reasoning ${state.reasoningEffort}` : ''}` : '',
    `Progres: ${state.turns} turn · tool ${state.tools.completed}/${state.tools.started} selesai${state.tools.failed ? ` · ${state.tools.failed} gagal` : ''}${state.tools.invalid ? ` · ${state.tools.invalid} argumen invalid` : ''}${state.tools.denied ? ` · ${state.tools.denied} ditolak` : ''}${state.tools.cancelled ? ` · ${state.tools.cancelled} dibatalkan` : ''}`,
    state.todos.length ? `Todo: ${done}/${state.todos.length} selesai${current ? ` · aktif: ${current}` : ''}` : 'Todo: tidak digunakan',
    state.activeTools.length ? `Tool aktif: ${state.activeTools.join(', ')}` : '',
    state.affectedFiles.length ? `File terdampak (${state.affectedFiles.length}): ${state.affectedFiles.slice(0, 12).join(', ')}${state.affectedFiles.length > 12 ? `, +${state.affectedFiles.length - 12} lainnya` : ''}` : 'File terdampak: tidak tercatat',
    `Verifikasi: ${verification}${state.ranCommands ? ' · command pernah dijalankan' : ''}`,
    state.criticReviews ? `Review otomatis: ${state.criticReviews} putaran · ${state.criticFindings} temuan` : '',
    state.loopWarnings || state.loopBlocks ? `Loop guard: ${state.loopWarnings} peringatan · ${state.loopBlocks} pemblokiran` : '',
    state.protocolWarnings || state.protocolFallbacks || state.protocolStops ? `Tool protocol: ${state.protocolWarnings} peringatan · ${state.protocolFallbacks} fallback model · ${state.protocolStops} dihentikan` : '',
    state.evidenceCacheHits ? `Evidence cache: ${state.evidenceCacheHits} hit · ${state.evidenceCacheSavedCharacters.toLocaleString('id-ID')} karakter tidak dikirim ulang` : '',
    state.contextPrioritizedMessages ? `Context relevance: ${state.contextPrioritizedMessages} pesan lama relevan dipertahankan` : '',
    state.parallelDiscoveryBatches ? `Parallel discovery: ${state.parallelDiscoveryCalls} tool call dalam ${state.parallelDiscoveryBatches} batch` : '',
    state.truncatedToolResults ? `Tool result store: ${state.truncatedToolResults} hasil besar · ${state.deferredToolResultCharacters.toLocaleString('id-ID')} karakter ditahan dari context` : '',
    state.promptInjectionDetected ? 'Keamanan: sinyal prompt injection terdeteksi; approval berisiko harus diperiksa ulang.' : '',
  ].filter(Boolean).join('\n')
}
