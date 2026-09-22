/** Mode headless untuk script, CI, editor, dan orkestrator agent lain. */

import { stdin, stdout, stderr } from 'node:process'
import { homedir } from 'node:os'
import {
  acceptedEffort,
  automaticReviewEnabled,
  AttachmentError,
  Agent,
  createDefaultRegistry,
  evaluatePermission,
  expandPromptCommand,
  inspectSandbox,
  journalAgentEvents,
  loadHooks,
  loadInstructions,
  loadPermissionPolicy,
  loadPromptCommands,
  loadSkills,
  LocalRunTrace,
  NineRouterProvider,
  PersistentRunJournal,
  resolveSandboxPolicy,
  storeImageFile,
  traceAgentEvents,
  tracingEnabled,
  type AgentEvent,
  type ModelMode,
  type SandboxStatus,
  type ToolRegistry,
  profilesFromConfig,
} from '@boo/core'
import { loadConfig } from '@boo/core/config/config.ts'
import { SessionRecorder } from '@boo/core/session/sessions.ts'

const DEFAULT_MODEL = 'ag/gemini-3.1-pro'
const DEFAULT_BASE_URL = 'http://localhost:20128'
const MAX_STDIN_PROMPT_BYTES = 1024 * 1024

export type HeadlessApproval = 'never' | 'workspace'

export interface ExecArguments {
  prompt: string
  json: boolean
  ephemeral: boolean
  approval: HeadlessApproval
  model?: string
  effort?: string
  sandbox?: string
  images: string[]
  help: boolean
}

export class ExecUsageError extends Error {}

export const EXEC_USAGE = `boo-code exec — jalankan satu tugas tanpa UI interaktif

  boo-code exec "periksa dan perbaiki test"
  boo-code exec --json "jelaskan struktur proyek"
  cat task.md | boo-code exec --full-auto

Opsi:
  --json                    keluarkan event JSONL dan hasil akhir terstruktur
  --approval <mode>         never (bawaan) atau workspace
  --full-auto               alias --approval workspace
  --ephemeral               jangan simpan isi percakapan sebagai sesi
  --model <id|auto>         model untuk run ini
  --effort <tingkat>        tingkat penalaran model manual
  --sandbox <mode>          workspace-write, read-only, danger-full-access
  --image <path>            lampirkan gambar; dapat diulang maksimal lima kali
  --help                    tampilkan bantuan ini

Tanpa prompt posisi, prompt dibaca dari stdin. Mode workspace hanya menyetujui
file tools dan command lokal yang dijaga OS sandbox; aksi eksternal tetap ditolak.`

function valueAfter(args: string[], index: number, flag: string): { value: string; next: number } {
  const value = args[index + 1]
  if (!value || value.startsWith('-')) throw new ExecUsageError(`${flag} membutuhkan nilai.`)
  return { value, next: index + 1 }
}

/** Parser mandiri agar salah flag gagal sebelum provider atau filesystem dipakai. */
export function parseExecArguments(args: readonly string[]): ExecArguments {
  const positional: string[] = []
  let json = false
  let ephemeral = false
  let approval: HeadlessApproval = 'never'
  let model: string | undefined
  let effort: string | undefined
  let sandbox: string | undefined
  const images: string[] = []
  let help = false
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--') {
      positional.push(...args.slice(index + 1))
      break
    }
    if (arg === '--json') { json = true; continue }
    if (arg === '--ephemeral') { ephemeral = true; continue }
    if (arg === '--full-auto') { approval = 'workspace'; continue }
    if (arg === '--help' || arg === '-h') { help = true; continue }
    const inline = /^(--approval|--model|--effort|--sandbox|--image)=(.*)$/.exec(arg)
    if (inline) {
      if (!inline[2]) throw new ExecUsageError(`${inline[1]} membutuhkan nilai.`)
      if (inline[1] === '--approval') approval = inline[2] as HeadlessApproval
      else if (inline[1] === '--model') model = inline[2]
      else if (inline[1] === '--effort') effort = inline[2]
      else if (inline[1] === '--sandbox') sandbox = inline[2]
      else images.push(inline[2])
      continue
    }
    if (arg === '--approval' || arg === '--model' || arg === '-m' || arg === '--effort' || arg === '--sandbox' || arg === '--image') {
      const parsed = valueAfter([...args], index, arg)
      index = parsed.next
      if (arg === '--approval') approval = parsed.value as HeadlessApproval
      else if (arg === '--model' || arg === '-m') model = parsed.value
      else if (arg === '--effort') effort = parsed.value
      else if (arg === '--sandbox') sandbox = parsed.value
      else images.push(parsed.value)
      continue
    }
    if (arg.startsWith('-')) throw new ExecUsageError(`Opsi exec tidak dikenal: ${arg}`)
    positional.push(arg)
  }
  if (approval !== 'never' && approval !== 'workspace') throw new ExecUsageError(`Mode approval tidak sah: ${approval}`)
  if (sandbox !== undefined && !['workspace-write', 'read-only', 'danger-full-access'].includes(sandbox)) {
    throw new ExecUsageError(`Mode sandbox tidak sah: ${sandbox}`)
  }
  if (images.length > 5) throw new ExecUsageError('Maksimal lima --image per prompt.')
  return { prompt: positional.join(' ').trim(), json, ephemeral, approval, model, effort, sandbox, images, help }
}

const WORKSPACE_FILE_TOOLS = new Set(['write_file', 'edit_file', 'apply_patch', 'delegate_write'])
const SANDBOXED_COMMAND_TOOLS = new Set(['bash', 'diagnostics', 'lsp'])

/** Kebijakan full-auto sengaja tidak memasukkan aplikasi, pesan, memori, atau MCP. */
export function approveHeadlessAction(
  name: string,
  approval: HeadlessApproval,
  registry: ToolRegistry,
  sandbox: SandboxStatus,
): boolean {
  if (approval === 'never') return false
  const tool = registry.get(name)
  if (!tool) return false
  if (WORKSPACE_FILE_TOOLS.has(name)) return tool.writesWorkspace === true
  return SANDBOXED_COMMAND_TOOLS.has(name)
    && tool.runsCommand === true
    && sandbox.enforced
    && sandbox.mode !== 'danger-full-access'
    && !sandbox.networkAccess
}

async function promptFromStdin(): Promise<string> {
  if (stdin.isTTY) throw new ExecUsageError('Tulis prompt setelah `boo-code exec`, atau kirim melalui stdin.')
  stdin.setEncoding('utf8')
  let prompt = ''
  for await (const chunk of stdin) {
    prompt += chunk
    if (Buffer.byteLength(prompt) > MAX_STDIN_PROMPT_BYTES) throw new ExecUsageError('Prompt stdin melebihi batas 1 MiB.')
  }
  if (!prompt.trim()) throw new ExecUsageError('Prompt kosong.')
  return prompt.trim()
}

function answerOf(agent: Agent): string {
  return [...agent.history].reverse().find((message) => message.role === 'assistant' && !message.tool_calls?.length)?.content?.trim() ?? ''
}

function emitJson(value: Record<string, unknown>): void {
  stdout.write(`${JSON.stringify(value)}\n`)
}

function jsonEvent(event: AgentEvent): Record<string, unknown> | null {
  switch (event.type) {
    case 'model-routing': return { type: 'model.routing' }
    case 'model-selected': return { type: 'model.selected', model: event.model, reasoning_effort: event.reasoningEffort ?? null, difficulty: event.difficulty, source: event.source, routing_policy: event.routingPolicy ?? 'static', performance_samples: event.performanceSamples ?? null, reason: event.reason }
    case 'turn-start': return { type: 'turn.started', turn: event.turn }
    case 'text': return { type: 'assistant.delta', text: event.delta }
    case 'tool-start': return { type: 'tool.started', id: event.callId, name: event.name, preview: event.preview }
    case 'tool-cache-hit': return { type: 'tool.cache_hit', id: event.callId, name: event.name, ref: event.ref, saved_characters: event.savedCharacters }
    case 'tool-result-truncated': return { type: 'tool.result_truncated', id: event.callId, name: event.name, ref: event.ref ?? null, original_characters: event.originalCharacters, visible_characters: event.visibleCharacters }
    case 'tool-parallel': return { type: `tool.parallel_${event.stage}`, name: event.name, tools: event.tools, calls: event.calls, duration_ms: event.durationMs ?? null }
    case 'tool-end': return { type: 'tool.completed', id: event.callId, name: event.name, status: event.cancelled ? 'cancelled' : event.isError ? 'failed' : 'completed' }
    case 'tool-denied': return { type: 'tool.denied', id: event.callId, name: event.name }
    case 'tool-invalid': return { type: 'tool.invalid', id: event.callId, name: event.name, kind: event.kind, issues: event.issues }
    case 'tool-loop': return { type: `tool.loop_${event.stage}`, name: event.name, repetitions: event.repetitions }
    case 'tool-protocol': return { type: `tool.protocol_${event.stage}`, model: event.model, consecutive_turns: event.consecutiveTurns, failures: event.failures, kinds: event.kinds }
    case 'hook-start': return { type: 'hook.started', event: event.event, id: event.id }
    case 'hook-end': return { type: 'hook.completed', event: event.event, id: event.id, status: event.denied ? 'denied' : event.success ? 'completed' : 'failed' }
    case 'retry': return { type: 'model.retry', attempt: event.attempt, max_attempts: event.maxAttempts, delay_ms: event.delayMs, error: event.message }
    case 'context-trimmed': return { type: 'context.trimmed', dropped_messages: event.droppedMessages, estimated_tokens: event.estimatedTokens, prioritized_messages: event.prioritizedMessages }
    case 'instructions-reloaded': return { type: 'instructions.reloaded', files: event.files.map((file) => ({ label: file.label, scope: file.scope ?? null, truncated: file.truncated })) }
    case 'verification-incomplete': return { type: 'verification.incomplete', files: event.files, attempted: event.attempted }
    case 'critic-start': return { type: 'critic.started', round: event.round }
    case 'critic-end': return { type: 'critic.completed', round: event.round, model: event.model, status: event.status, findings: event.findings, ...(event.message ? { message: event.message } : {}) }
    case 'steering': return { type: 'steering.applied', count: event.messages.length }
    case 'risk-assessed': return { type: 'risk.assessed', level: event.assessment.level, score: event.assessment.score, reasons: event.assessment.reasons, changed_files: event.assessment.changedFiles, changed_lines: event.assessment.changedLines }
    case 'risk-verification-weak': return { type: 'risk.verification_weak', level: event.assessment.level, reasons: event.assessment.reasons }
    case 'turn-limit': return { type: 'turn.limit', turns: event.turns }
    case 'cancelled': return { type: 'run.cancelled' }
    case 'error': return { type: 'run.error', error: event.message }
    default: return null
  }
}

/** Menjalankan satu task dan mengembalikan exit code proses. */
export async function runExec(rawArgs: readonly string[], workspace = process.cwd()): Promise<number> {
  let options: ExecArguments
  try { options = parseExecArguments(rawArgs) } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : 'Argumen exec tidak sah.'}\n`)
    stderr.write('Pakai `boo-code exec --help` untuk bantuan.\n')
    return 2
  }
  if (options.help) { stdout.write(`${EXEC_USAGE}\n`); return 0 }

  let prompt: string
  try { prompt = options.prompt || await promptFromStdin() } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : 'Prompt tidak dapat dibaca.'}\n`)
    return 2
  }
  const config = loadConfig(workspace)
  if (!config.NINEROUTER_KEY) {
    stderr.write('NINEROUTER_KEY belum dikonfigurasi. Jalankan `boo-code setup`.\n')
    return 1
  }
  const requestedModel = options.model ?? config.BOO_MODEL ?? 'auto'
  const modelMode: ModelMode = requestedModel === 'auto' ? 'auto' : 'manual'
  const model = requestedModel === 'auto' ? DEFAULT_MODEL : requestedModel
  const effort = modelMode === 'manual' ? acceptedEffort(model, options.effort ?? config.BOO_EFFORT) : undefined
  const sandboxPolicy = resolveSandboxPolicy(options.sandbox ?? config.BOO_SANDBOX, config.BOO_NETWORK_ACCESS)
  const sandboxStatus = inspectSandbox(workspace, sandboxPolicy)
  const registry = createDefaultRegistry()
  const provider = new NineRouterProvider({
    baseUrl: config.NINEROUTER_URL || DEFAULT_BASE_URL,
    apiKey: config.NINEROUTER_KEY ?? '',
    profiles: profilesFromConfig(config),
    model,
    reasoningEffort: effort,
    home: homedir(),
  })
  const recorder = new SessionRecorder({ workspace, model, reasoningEffort: effort, modelMode })
  const command = expandPromptCommand(prompt, loadPromptCommands({ workspace, home: homedir() }))
  const request = command?.prompt ?? prompt
  let images
  try { images = options.images.map((path) => storeImageFile(path, { sessionId: recorder.id, home: homedir() })) } catch (error) {
    stderr.write(`${error instanceof AttachmentError || error instanceof Error ? error.message : 'Gambar tidak dapat dilampirkan.'}\n`)
    return 2
  }
  const controller = new AbortController()
  const interrupt = () => controller.abort()
  process.once('SIGINT', interrupt)
  const startedAt = Date.now()
  let status: 'success' | 'incomplete' | 'error' | 'cancelled' = 'success'
  let failure = ''
  let turns = 0
  let toolCalls = 0
  let selectedModel = model
  let selectedEffort = effort

  const agent = new Agent({
    provider,
    registry,
    workspace,
    home: homedir(),
    autoReview: automaticReviewEnabled(config.BOO_AUTO_REVIEW),
    modelMode,
    sessionId: recorder.id,
    sandbox: sandboxPolicy,
    instructions: (targets) => loadInstructions({ workspace, home: homedir(), targets }),
    skills: () => loadSkills({ workspace, home: homedir() }),
    hooks: () => loadHooks(workspace, homedir()),
    askUser: async () => ({ cancelled: true }),
    askPermission: async ({ name, args, promptInjectionRisk }) => {
      // Mode headless tidak dapat meminta konfirmasi segar setelah data berbahaya.
      if (promptInjectionRisk) return false
      const configured = evaluatePermission(loadPermissionPolicy({ workspace, home: homedir() }), { tool: name, args })
      // Headless tidak mempunyai dialog: ask dan deny sama-sama berhenti. Allow
      // tidak memperluas --approval; batas `never`/`workspace` tetap berkuasa.
      if (configured?.effect === 'deny' || configured?.effect === 'ask') return false
      return approveHeadlessAction(name, options.approval, registry, sandboxStatus)
    },
    onTurnLimit: async () => false,
    ...(Number(config.BOO_MAX_TURNS) > 0 ? { maxTurns: Number(config.BOO_MAX_TURNS) } : {}),
    ...(config.BOO_MAX_CONTEXT_TOKENS ? { maxContextTokens: Number(config.BOO_MAX_CONTEXT_TOKENS) } : {}),
    ...(options.ephemeral ? {} : {
      onMessage: (message) => recorder.recordMessage(message),
      onCompaction: (compaction) => recorder.recordCompaction(compaction),
    }),
  })

  if (options.json) emitJson({
    type: 'session.started',
    session_id: options.ephemeral ? null : recorder.id,
    model_mode: modelMode,
    approval: options.approval,
    sandbox: sandboxStatus,
  })
  const trace = new LocalRunTrace({
    home: homedir(), workspace, surface: 'api', kind: 'send', mode: modelMode,
    model, reasoningEffort: effort, requestCharacters: request.length,
    enabled: tracingEnabled(config.BOO_TRACE),
  })
  const journal = new PersistentRunJournal({ home: homedir(), workspace, sessionId: recorder.id, surface: 'api', kind: 'send' })
  try {
    const events = journalAgentEvents(traceAgentEvents(agent.send(request, { signal: controller.signal, ...(images.length ? { images } : {}) }), trace), journal)
    for await (const event of events) {
      if (event.type === 'turn-start') turns += 1
      else if (event.type === 'tool-start') toolCalls += 1
      else if (event.type === 'model-selected') {
        selectedModel = event.model
        selectedEffort = event.reasoningEffort
        if (!options.ephemeral) recorder.recordModel(event.model, event.reasoningEffort)
      } else if (event.type === 'verification-incomplete' || event.type === 'turn-limit') status = 'incomplete'
      else if (event.type === 'tool-loop' && event.stage === 'stopped') status = 'incomplete'
      else if (event.type === 'cancelled') status = 'cancelled'
      else if (event.type === 'error') { status = 'error'; failure = event.message }
      if (options.json) {
        const item = jsonEvent(event)
        if (item) emitJson(item)
      }
    }
  } catch (error) {
    status = controller.signal.aborted ? 'cancelled' : 'error'
    failure = error instanceof Error ? error.message : 'Run gagal.'
  } finally {
    process.removeListener('SIGINT', interrupt)
  }
  const answer = answerOf(agent)
  if (status === 'success' && !answer) { status = 'error'; failure ||= 'Model tidak menghasilkan jawaban akhir.' }
  const result = {
    type: 'result', status, answer, error: failure || null,
    session_id: options.ephemeral ? null : recorder.id,
    model: selectedModel, reasoning_effort: selectedEffort ?? null,
    turns, tool_calls: toolCalls, duration_ms: Date.now() - startedAt,
  }
  if (options.json) emitJson(result)
  else {
    if (answer) stdout.write(`${answer}\n`)
    if (failure) stderr.write(`${failure}\n`)
  }
  return status === 'success' ? 0 : status === 'cancelled' ? 130 : status === 'error' ? 1 : 2
}
