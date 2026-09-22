/** Metrik lokal per permintaan, disimpan sebagai JSONL tanpa isi percakapan/kode. */

import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { AgentEvent } from '../agent/loop.ts'

export const TRACE_SCHEMA_VERSION = 1
export const TRACE_DIRECTORY = 'traces'
const MAX_READ_TRACES = 500

export type TraceSurface = 'cli' | 'web' | 'eval' | 'api'
export type TraceKind = 'send' | 'compact'
export type TraceOutcome = 'completed' | 'cancelled' | 'stopped' | 'error'

export interface ToolTraceMetric {
  calls: number
  failures: number
  durationMs: number
}

export interface RunTraceSummary {
  schemaVersion: 1
  id: string
  startedAt: number
  durationMs: number
  workspaceId: string
  surface: TraceSurface
  kind: TraceKind
  mode: 'auto' | 'manual'
  initialModel: string
  selectedModel?: string
  reasoningEffort?: string
  difficulty?: string
  routingSource?: string
  routingPolicy?: string
  requestCharacters: number
  outcome: TraceOutcome
  turns: number
  retries: number
  toolCalls: number
  toolFailures: number
  toolDenied: number
  verificationRequested: boolean
  verificationIncomplete: boolean
  criticReviews: number
  criticFindings: number
  criticFailures: number
  steeringMessages: number
  riskLevel?: 'low' | 'medium' | 'high'
  contextTrims: number
  contextPrioritizedMessages: number
  parallelDiscoveryBatches: number
  parallelDiscoveryCalls: number
  truncatedToolResults: number
  deferredToolResultCharacters: number
  /** Field trace lama sebelum scheduler mendukung tool discovery heterogen. */
  parallelReadBatches?: number
  parallelReadCalls?: number
  compactions: number
  toolProtocolWarnings: number
  toolProtocolFallbacks: number
  toolProtocolStops: number
  evidenceCacheHits: number
  evidenceCacheSavedCharacters: number
  tools: Record<string, ToolTraceMetric>
}

export interface TraceAggregate {
  runs: number
  completed: number
  cancelled: number
  stopped: number
  errors: number
  averageDurationMs: number
  averageTurns: number
  averageToolCalls: number
  toolFailureRate: number
  verificationIncomplete: number
  criticReviews: number
  criticFindings: number
  criticFailures: number
  steeringMessages: number
  highRiskRuns: number
  contextPrioritizedMessages: number
  parallelDiscoveryBatches: number
  parallelDiscoveryCalls: number
  truncatedToolResults: number
  deferredToolResultCharacters: number
  evidenceCacheHits: number
  evidenceCacheSavedCharacters: number
  models: Record<string, number>
  tools: Record<string, ToolTraceMetric>
}

export interface RunTraceOptions {
  home: string
  workspace: string
  surface: TraceSurface
  kind: TraceKind
  mode: 'auto' | 'manual'
  model: string
  reasoningEffort?: string
  requestCharacters: number
  enabled?: boolean
  now?: () => number
}

function workspaceId(workspace: string): string {
  return createHash('sha256').update(resolve(workspace)).digest('hex').slice(0, 20)
}

function traceRoot(home: string): string {
  return join(home, '.boo', TRACE_DIRECTORY)
}

function rounded(value: number): number {
  return Math.round(value * 10) / 10
}

/** Nilai selain false/0/off menyalakan trace lokal; default menyala. */
export function tracingEnabled(value: unknown): boolean {
  return !(typeof value === 'string' && /^(?:0|false|off|no)$/i.test(value.trim()))
}

export class LocalRunTrace {
  private readonly options: RunTraceOptions
  private readonly id = randomUUID()
  private readonly startedAt: number
  private readonly startedTools = new Map<string, { name: string; at: number }>()
  private readonly tools: Record<string, ToolTraceMetric> = {}
  private turns = 0
  private retries = 0
  private toolCalls = 0
  private toolFailures = 0
  private toolDenied = 0
  private verificationRequested = false
  private verificationIncomplete = false
  private criticReviews = 0
  private criticFindings = 0
  private criticFailures = 0
  private steeringMessages = 0
  private riskLevel: 'low' | 'medium' | 'high' | undefined
  private contextTrims = 0
  private contextPrioritizedMessages = 0
  private parallelDiscoveryBatches = 0
  private parallelDiscoveryCalls = 0
  private truncatedToolResults = 0
  private deferredToolResultCharacters = 0
  private compactions = 0
  private toolProtocolWarnings = 0
  private toolProtocolFallbacks = 0
  private toolProtocolStops = 0
  private evidenceCacheHits = 0
  private evidenceCacheSavedCharacters = 0
  private selectedModel: string | undefined
  private selectedEffort: string | undefined
  private difficulty: string | undefined
  private routingSource: string | undefined
  private routingPolicy: string | undefined
  private inferredOutcome: TraceOutcome = 'completed'
  private finished = false

  constructor(options: RunTraceOptions) {
    this.options = options
    this.startedAt = options.now?.() ?? Date.now()
  }

  record(event: AgentEvent): void {
    if (this.finished || this.options.enabled === false) return
    const now = this.options.now?.() ?? Date.now()
    switch (event.type) {
      case 'model-selected':
        this.selectedModel = event.model
        this.selectedEffort = event.reasoningEffort
        this.difficulty = event.difficulty
        this.routingSource = event.source
        this.routingPolicy = event.routingPolicy
        break
      case 'turn-start':
        this.turns += 1
        break
      case 'retry':
        this.retries += 1
        break
      case 'tool-start': {
        this.toolCalls += 1
        this.startedTools.set(event.callId, { name: event.name, at: now })
        const metric = this.tools[event.name] ?? { calls: 0, failures: 0, durationMs: 0 }
        metric.calls += 1
        this.tools[event.name] = metric
        break
      }
      case 'tool-end': {
        if (event.isError) this.toolFailures += 1
        const started = this.startedTools.get(event.callId)
        const name = started?.name ?? event.name
        const metric = this.tools[name] ?? { calls: 0, failures: 0, durationMs: 0 }
        if (event.isError) metric.failures += 1
        if (started) metric.durationMs += Math.max(0, now - started.at)
        this.tools[name] = metric
        this.startedTools.delete(event.callId)
        break
      }
      case 'tool-cache-hit':
        this.evidenceCacheHits += 1
        this.evidenceCacheSavedCharacters += event.savedCharacters
        break
      case 'tool-denied':
        this.toolDenied += 1
        this.startedTools.delete(event.callId)
        break
      case 'tool-invalid': {
        this.toolCalls += 1
        this.toolFailures += 1
        const metric = this.tools[event.name] ?? { calls: 0, failures: 0, durationMs: 0 }
        metric.calls += 1
        metric.failures += 1
        this.tools[event.name] = metric
        this.startedTools.delete(event.callId)
        break
      }
      case 'verification-needed':
        this.verificationRequested = true
        break
      case 'verification-incomplete':
        this.verificationIncomplete = true
        break
      case 'critic-start':
        this.criticReviews += 1
        break
      case 'critic-end':
        this.criticFindings += event.findings
        if (event.status === 'error') this.criticFailures += 1
        break
      case 'steering':
        this.steeringMessages += event.messages.length
        break
      case 'risk-assessed': {
        const rank = { low: 0, medium: 1, high: 2 } as const
        if (this.riskLevel === undefined || rank[event.assessment.level] > rank[this.riskLevel]) this.riskLevel = event.assessment.level
        break
      }
      case 'prompt-injection-detected':
        // Kejadian dihitung sebagai guardrail, tanpa menyimpan isi data atau path.
        break
      case 'tool-loop':
        if (event.stage === 'stopped') this.inferredOutcome = 'stopped'
        break
      case 'tool-protocol':
        if (event.stage === 'warning') this.toolProtocolWarnings += 1
        else if (event.stage === 'fallback') this.toolProtocolFallbacks += 1
        else {
          this.toolProtocolStops += 1
          this.inferredOutcome = 'stopped'
        }
        break
      case 'context-trimmed':
        this.contextTrims += 1
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
      case 'compacted':
        this.compactions += 1
        break
      case 'cancelled':
        this.inferredOutcome = 'cancelled'
        break
      case 'turn-limit':
        this.inferredOutcome = 'stopped'
        break
      case 'error':
        this.inferredOutcome = 'error'
        break
      default:
        break
    }
  }

  finish(outcome: TraceOutcome = this.inferredOutcome): RunTraceSummary | null {
    if (this.finished || this.options.enabled === false) return null
    this.finished = true
    const now = this.options.now?.() ?? Date.now()
    const summary: RunTraceSummary = {
      schemaVersion: TRACE_SCHEMA_VERSION,
      id: this.id,
      startedAt: this.startedAt,
      durationMs: Math.max(0, now - this.startedAt),
      workspaceId: workspaceId(this.options.workspace),
      surface: this.options.surface,
      kind: this.options.kind,
      mode: this.options.mode,
      initialModel: this.options.model,
      ...(this.selectedModel ? { selectedModel: this.selectedModel } : {}),
      ...(this.selectedEffort ?? this.options.reasoningEffort ? { reasoningEffort: this.selectedEffort ?? this.options.reasoningEffort } : {}),
      ...(this.difficulty ? { difficulty: this.difficulty } : {}),
      ...(this.routingSource ? { routingSource: this.routingSource } : {}),
      ...(this.routingPolicy ? { routingPolicy: this.routingPolicy } : {}),
      requestCharacters: Math.max(0, this.options.requestCharacters),
      outcome,
      turns: this.turns,
      retries: this.retries,
      toolCalls: this.toolCalls,
      toolFailures: this.toolFailures,
      toolDenied: this.toolDenied,
      verificationRequested: this.verificationRequested,
      verificationIncomplete: this.verificationIncomplete,
      criticReviews: this.criticReviews,
      criticFindings: this.criticFindings,
      criticFailures: this.criticFailures,
      steeringMessages: this.steeringMessages,
      ...(this.riskLevel ? { riskLevel: this.riskLevel } : {}),
      contextTrims: this.contextTrims,
      contextPrioritizedMessages: this.contextPrioritizedMessages,
      parallelDiscoveryBatches: this.parallelDiscoveryBatches,
      parallelDiscoveryCalls: this.parallelDiscoveryCalls,
      truncatedToolResults: this.truncatedToolResults,
      deferredToolResultCharacters: this.deferredToolResultCharacters,
      compactions: this.compactions,
      toolProtocolWarnings: this.toolProtocolWarnings,
      toolProtocolFallbacks: this.toolProtocolFallbacks,
      toolProtocolStops: this.toolProtocolStops,
      evidenceCacheHits: this.evidenceCacheHits,
      evidenceCacheSavedCharacters: this.evidenceCacheSavedCharacters,
      tools: this.tools,
    }
    const root = traceRoot(this.options.home)
    mkdirSync(root, { recursive: true, mode: 0o700 })
    const target = join(root, `${this.startedAt}-${this.id}.jsonl`)
    const temporary = `${target}.tmp`
    writeFileSync(temporary, `${JSON.stringify(summary)}\n`, { mode: 0o600, flag: 'wx' })
    renameSync(temporary, target)
    return summary
  }
}

function readTraces(home: string, workspace: string, limit: number): RunTraceSummary[] {
  const root = traceRoot(home)
  let names: string[]
  try { names = readdirSync(root).filter((name) => name.endsWith('.jsonl')).sort().reverse() } catch { return [] }
  const expectedWorkspace = workspaceId(workspace)
  const output: RunTraceSummary[] = []
  for (const name of names.slice(0, Math.min(MAX_READ_TRACES, Math.max(limit * 4, limit)))) {
    try {
      const path = join(root, name)
      if (!statSync(path).isFile()) continue
      const parsed = JSON.parse(readFileSync(path, 'utf8').trim()) as RunTraceSummary
      if (parsed.schemaVersion === TRACE_SCHEMA_VERSION && parsed.workspaceId === expectedWorkspace) output.push(parsed)
      if (output.length >= limit) break
    } catch {
      // Trace yang terpotong/rusak dilewati; metrik tidak boleh memblokir agent.
    }
  }
  return output
}

export function aggregateLocalTraces(home: string, workspace: string, limit = 100): TraceAggregate {
  const traces = readTraces(home, workspace, Math.max(1, Math.min(MAX_READ_TRACES, limit)))
  const models: Record<string, number> = {}
  const tools: Record<string, ToolTraceMetric> = {}
  let duration = 0
  let turns = 0
  let calls = 0
  let failures = 0
  for (const trace of traces) {
    duration += trace.durationMs
    turns += trace.turns
    calls += trace.toolCalls
    failures += trace.toolFailures
    const model = trace.selectedModel ?? trace.initialModel
    models[model] = (models[model] ?? 0) + 1
    for (const [name, metric] of Object.entries(trace.tools)) {
      const total = tools[name] ?? { calls: 0, failures: 0, durationMs: 0 }
      total.calls += metric.calls
      total.failures += metric.failures
      total.durationMs += metric.durationMs
      tools[name] = total
    }
  }
  return {
    runs: traces.length,
    completed: traces.filter((trace) => trace.outcome === 'completed').length,
    cancelled: traces.filter((trace) => trace.outcome === 'cancelled').length,
    stopped: traces.filter((trace) => trace.outcome === 'stopped').length,
    errors: traces.filter((trace) => trace.outcome === 'error').length,
    averageDurationMs: traces.length ? rounded(duration / traces.length) : 0,
    averageTurns: traces.length ? rounded(turns / traces.length) : 0,
    averageToolCalls: traces.length ? rounded(calls / traces.length) : 0,
    toolFailureRate: calls ? rounded((failures / calls) * 100) : 0,
    verificationIncomplete: traces.filter((trace) => trace.verificationIncomplete).length,
    criticReviews: traces.reduce((sum, trace) => sum + (trace.criticReviews ?? 0), 0),
    criticFindings: traces.reduce((sum, trace) => sum + (trace.criticFindings ?? 0), 0),
    criticFailures: traces.reduce((sum, trace) => sum + (trace.criticFailures ?? 0), 0),
    steeringMessages: traces.reduce((sum, trace) => sum + (trace.steeringMessages ?? 0), 0),
    highRiskRuns: traces.filter((trace) => trace.riskLevel === 'high').length,
    contextPrioritizedMessages: traces.reduce((sum, trace) => sum + (trace.contextPrioritizedMessages ?? 0), 0),
    parallelDiscoveryBatches: traces.reduce((sum, trace) => sum + (trace.parallelDiscoveryBatches ?? trace.parallelReadBatches ?? 0), 0),
    parallelDiscoveryCalls: traces.reduce((sum, trace) => sum + (trace.parallelDiscoveryCalls ?? trace.parallelReadCalls ?? 0), 0),
    truncatedToolResults: traces.reduce((sum, trace) => sum + (trace.truncatedToolResults ?? 0), 0),
    deferredToolResultCharacters: traces.reduce((sum, trace) => sum + (trace.deferredToolResultCharacters ?? 0), 0),
    evidenceCacheHits: traces.reduce((sum, trace) => sum + (trace.evidenceCacheHits ?? 0), 0),
    evidenceCacheSavedCharacters: traces.reduce((sum, trace) => sum + (trace.evidenceCacheSavedCharacters ?? 0), 0),
    models,
    tools,
  }
}

/** Membungkus event stream agar semua surface mencatat definisi metrik yang sama. */
export async function* traceAgentEvents(events: AsyncGenerator<AgentEvent>, trace: LocalRunTrace): AsyncGenerator<AgentEvent> {
  let completed = false
  try {
    for await (const event of events) {
      trace.record(event)
      yield event
    }
    completed = true
  } finally {
    trace.finish(completed ? undefined : 'stopped')
  }
}
