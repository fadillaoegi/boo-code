/** Postmortem kegagalan berbasis event lokal; tidak menyimpan prompt, source, args, atau output. */

import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { AgentEvent } from './loop.ts'

export const FAILURE_POSTMORTEM_SCHEMA_VERSION = 1
export const FAILURE_POSTMORTEM_DIRECTORY = 'postmortems'
const MAX_POSTMORTEMS = 100
const MAX_POSTMORTEM_BYTES = 128 * 1024
const MAX_TOOL_NAMES = 24

export type FailureOutcome = 'error' | 'stopped' | 'incomplete'
export type FailureCategory =
  | 'provider-auth'
  | 'provider-rate-limit'
  | 'provider-unavailable'
  | 'provider-context'
  | 'provider-request'
  | 'provider-transport'
  | 'tool-timeout'
  | 'tool-failure'
  | 'tool-denied'
  | 'tool-arguments'
  | 'tool-loop'
  | 'tool-protocol'
  | 'verification'
  | 'turn-limit'
  | 'unknown'

export interface FailurePostmortemReport {
  schemaVersion: 1
  id: string
  workspaceId: string
  startedAt: number
  finishedAt: number
  durationMs: number
  outcome: FailureOutcome
  category: FailureCategory
  model?: string
  reasoningEffort?: string
  turns: number
  retries: number
  toolCalls: number
  toolFailures: number
  toolDenied: number
  toolInvalid: number
  toolTimeouts: number
  failedTools: string[]
  timeoutTools: string[]
  verificationRequested: boolean
  verificationIncomplete: boolean
  verificationRepairRounds: number
  verificationRepairExhausted: number
  protocolWarnings: number
  protocolFallbacks: number
  protocolStops: number
  protocolKinds: string[]
  loopWarnings: number
  loopBlocks: number
  loopStops: number
  promptInjectionDetected: boolean
}

interface FailurePostmortemOptions {
  workspace: string
  home?: string
  model?: string
  reasoningEffort?: string
  now?: () => number
}

const CATEGORIES = new Set<FailureCategory>([
  'provider-auth', 'provider-rate-limit', 'provider-unavailable', 'provider-context', 'provider-request',
  'provider-transport', 'tool-timeout', 'tool-failure', 'tool-denied', 'tool-arguments', 'tool-loop',
  'tool-protocol', 'verification', 'turn-limit', 'unknown',
])

function workspaceId(workspace: string): string {
  return createHash('sha256').update(resolve(workspace)).digest('hex').slice(0, 24)
}

function root(home: string, workspace: string): string {
  return join(home, '.boo', FAILURE_POSTMORTEM_DIRECTORY, workspaceId(workspace))
}

function safeName(value: unknown, maximum = 160): string | null {
  if (typeof value !== 'string' || !value || value.length > maximum
    || Array.from(value).some((character) => {
      const code = character.charCodeAt(0)
      return code < 32 || (code >= 127 && code <= 159)
    })) return null
  return value
}

function safeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function safeNames(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_TOOL_NAMES) return null
  const names = value.map((item) => safeName(item, 100))
  return names.some((item) => item === null) ? null : names as string[]
}

export function parseFailurePostmortem(value: unknown): FailurePostmortemReport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Postmortem harus berupa object.')
  const item = value as Record<string, unknown>
  if (item.schemaVersion !== FAILURE_POSTMORTEM_SCHEMA_VERSION) throw new Error(`Versi postmortem tidak didukung: ${String(item.schemaVersion)}.`)
  const id = safeName(item.id, 100)
  const workspace = safeName(item.workspaceId, 64)
  const model = item.model === undefined ? undefined : safeName(item.model, 300)
  const effort = item.reasoningEffort === undefined ? undefined : safeName(item.reasoningEffort, 40)
  const failedTools = safeNames(item.failedTools)
  const timeoutTools = safeNames(item.timeoutTools)
  const protocolKinds = safeNames(item.protocolKinds)
  const numbers = [
    item.startedAt, item.finishedAt, item.durationMs, item.turns, item.retries, item.toolCalls, item.toolFailures,
    item.toolDenied, item.toolInvalid, item.toolTimeouts, item.verificationRepairRounds,
    item.verificationRepairExhausted, item.protocolWarnings, item.protocolFallbacks, item.protocolStops,
    item.loopWarnings, item.loopBlocks, item.loopStops,
  ]
  if (!id || !/^[a-zA-Z0-9-]+$/.test(id) || !workspace || !/^[a-f0-9]{24}$/.test(workspace)
    || model === null || effort === null || !failedTools || !timeoutTools || !protocolKinds
    || !numbers.every(safeInteger) || !['error', 'stopped', 'incomplete'].includes(String(item.outcome))
    || !CATEGORIES.has(item.category as FailureCategory)
    || typeof item.verificationRequested !== 'boolean' || typeof item.verificationIncomplete !== 'boolean'
    || typeof item.promptInjectionDetected !== 'boolean') throw new Error('Postmortem tidak valid.')
  return {
    schemaVersion: 1,
    id,
    workspaceId: workspace,
    startedAt: item.startedAt as number,
    finishedAt: item.finishedAt as number,
    durationMs: item.durationMs as number,
    outcome: item.outcome as FailureOutcome,
    category: item.category as FailureCategory,
    ...(model ? { model } : {}),
    ...(effort ? { reasoningEffort: effort } : {}),
    turns: item.turns as number,
    retries: item.retries as number,
    toolCalls: item.toolCalls as number,
    toolFailures: item.toolFailures as number,
    toolDenied: item.toolDenied as number,
    toolInvalid: item.toolInvalid as number,
    toolTimeouts: item.toolTimeouts as number,
    failedTools,
    timeoutTools,
    verificationRequested: item.verificationRequested,
    verificationIncomplete: item.verificationIncomplete,
    verificationRepairRounds: item.verificationRepairRounds as number,
    verificationRepairExhausted: item.verificationRepairExhausted as number,
    protocolWarnings: item.protocolWarnings as number,
    protocolFallbacks: item.protocolFallbacks as number,
    protocolStops: item.protocolStops as number,
    protocolKinds,
    loopWarnings: item.loopWarnings as number,
    loopBlocks: item.loopBlocks as number,
    loopStops: item.loopStops as number,
    promptInjectionDetected: item.promptInjectionDetected,
  }
}

function classifyProviderError(message: string): FailureCategory {
  if (/(?:401|403|unauthori[sz]ed|forbidden|api key|authentication)/i.test(message)) return 'provider-auth'
  if (/(?:429|rate.?limit|quota|capacity|overloaded|reset after)/i.test(message)) return 'provider-rate-limit'
  if (/(?:404|not found|requested entity|model.{0,20}(?:missing|unavailable|not exist))/i.test(message)) return 'provider-unavailable'
  if (/(?:context.{0,30}(?:length|window|limit)|maximum context|too many tokens|input.{0,20}too (?:long|large))/i.test(message)) return 'provider-context'
  if (/(?:timeout|timed out|connection|network|socket|fetch|econn|enotfound|tidak mengirim data)/i.test(message)) return 'provider-transport'
  if (/(?:400|bad request|unsupported|invalid request)/i.test(message)) return 'provider-request'
  return 'unknown'
}

function normalizedName(value: string, maximum: number): string {
  return Array.from(value, (character) => {
    const code = character.charCodeAt(0)
    return code < 32 || (code >= 127 && code <= 159) ? '' : character
  }).join('').trim().slice(0, maximum)
}

function orderedUnique(values: readonly string[]): string[] {
  const normalized = values.map((value) => normalizedName(value, 100)).filter(Boolean)
  return [...new Set(normalized)].slice(0, MAX_TOOL_NAMES)
}

export class FailurePostmortemTracker {
  private readonly options: FailurePostmortemOptions
  private readonly startedAt: number
  private model: string | undefined
  private reasoningEffort: string | undefined
  private outcome: FailureOutcome | null = null
  private errorCategory: FailureCategory = 'unknown'
  private turns = 0
  private retries = 0
  private toolCalls = 0
  private toolFailures = 0
  private toolDenied = 0
  private toolInvalid = 0
  private toolTimeouts = 0
  private readonly failedTools: string[] = []
  private readonly timeoutTools: string[] = []
  private verificationRequested = false
  private verificationIncomplete = false
  private verificationRepairRounds = 0
  private verificationRepairExhausted = 0
  private protocolWarnings = 0
  private protocolFallbacks = 0
  private protocolStops = 0
  private readonly protocolKinds: string[] = []
  private loopWarnings = 0
  private loopBlocks = 0
  private loopStops = 0
  private promptInjectionDetected = false
  private finished = false

  constructor(options: FailurePostmortemOptions) {
    this.options = options
    this.startedAt = options.now?.() ?? Date.now()
    this.model = options.model ? normalizedName(options.model, 300) || undefined : undefined
    this.reasoningEffort = options.reasoningEffort ? normalizedName(options.reasoningEffort, 40) || undefined : undefined
  }

  record(event: AgentEvent): void {
    if (this.finished) return
    switch (event.type) {
      case 'model-selected':
        this.model = normalizedName(event.model, 300) || undefined
        this.reasoningEffort = event.reasoningEffort ? normalizedName(event.reasoningEffort, 40) || undefined : undefined
        break
      case 'turn-start': this.turns = Math.max(this.turns, event.turn + 1); break
      case 'retry': this.retries += 1; break
      case 'tool-start': this.toolCalls += 1; break
      case 'tool-end':
        if (event.isError) { this.toolFailures += 1; this.failedTools.push(event.name) }
        break
      case 'tool-denied': this.toolDenied += 1; this.failedTools.push(event.name); break
      case 'tool-invalid': this.toolInvalid += 1; this.failedTools.push(event.name); break
      case 'tool-recovery':
        if (event.kind === 'timeout') { this.toolTimeouts += 1; this.timeoutTools.push(event.name) }
        break
      case 'verification-needed': this.verificationRequested = true; break
      case 'verification-incomplete': this.verificationIncomplete = true; this.outcome = 'incomplete'; break
      case 'verification-repair':
        this.verificationRepairRounds = Math.max(this.verificationRepairRounds, event.round)
        if (event.stage === 'exhausted') this.verificationRepairExhausted += 1
        break
      case 'tool-protocol':
        this.protocolKinds.push(...event.kinds)
        if (event.stage === 'warning') this.protocolWarnings += 1
        else if (event.stage === 'fallback') this.protocolFallbacks += 1
        else { this.protocolStops += 1; this.outcome = 'stopped' }
        break
      case 'tool-loop':
        if (event.stage === 'warning') this.loopWarnings += 1
        else this.loopBlocks += 1
        if (event.stage === 'stopped') { this.loopStops += 1; this.outcome = 'stopped' }
        break
      case 'prompt-injection-detected': this.promptInjectionDetected = true; break
      case 'turn-limit': this.outcome = 'stopped'; break
      case 'error': this.errorCategory = classifyProviderError(event.message); this.outcome = 'error'; break
      case 'cancelled': this.outcome = null; break
      default: break
    }
  }

  recordThrown(error: unknown): void {
    this.errorCategory = classifyProviderError(error instanceof Error ? error.message : '')
    this.outcome = 'error'
  }

  private category(): FailureCategory {
    if (this.verificationIncomplete || this.verificationRepairExhausted) return 'verification'
    if (this.protocolStops) return 'tool-protocol'
    if (this.loopStops) return 'tool-loop'
    if (this.errorCategory !== 'unknown') return this.errorCategory
    if (this.toolTimeouts) return 'tool-timeout'
    if (this.toolInvalid) return 'tool-arguments'
    if (this.toolDenied) return 'tool-denied'
    if (this.toolFailures) return 'tool-failure'
    if (this.outcome === 'stopped') return 'turn-limit'
    return 'unknown'
  }

  finish(): FailurePostmortemReport | null {
    if (this.finished) return null
    this.finished = true
    if (!this.outcome) return null
    const finishedAt = this.options.now?.() ?? Date.now()
    const report: FailurePostmortemReport = {
      schemaVersion: 1,
      id: randomUUID(),
      workspaceId: workspaceId(this.options.workspace),
      startedAt: this.startedAt,
      finishedAt,
      durationMs: Math.max(0, finishedAt - this.startedAt),
      outcome: this.outcome,
      category: this.category(),
      ...(this.model ? { model: this.model } : {}),
      ...(this.reasoningEffort ? { reasoningEffort: this.reasoningEffort } : {}),
      turns: this.turns,
      retries: this.retries,
      toolCalls: this.toolCalls,
      toolFailures: this.toolFailures,
      toolDenied: this.toolDenied,
      toolInvalid: this.toolInvalid,
      toolTimeouts: this.toolTimeouts,
      failedTools: orderedUnique(this.failedTools),
      timeoutTools: orderedUnique(this.timeoutTools),
      verificationRequested: this.verificationRequested,
      verificationIncomplete: this.verificationIncomplete,
      verificationRepairRounds: this.verificationRepairRounds,
      verificationRepairExhausted: this.verificationRepairExhausted,
      protocolWarnings: this.protocolWarnings,
      protocolFallbacks: this.protocolFallbacks,
      protocolStops: this.protocolStops,
      protocolKinds: orderedUnique(this.protocolKinds),
      loopWarnings: this.loopWarnings,
      loopBlocks: this.loopBlocks,
      loopStops: this.loopStops,
      promptInjectionDetected: this.promptInjectionDetected,
    }
    if (this.options.home) {
      try { saveFailurePostmortem(this.options.home, this.options.workspace, report) } catch { /* Diagnostik tidak boleh menggagalkan task. */ }
    }
    return report
  }
}

export function saveFailurePostmortem(home: string, workspace: string, report: FailurePostmortemReport): string {
  const validated = parseFailurePostmortem(report)
  if (validated.workspaceId !== workspaceId(workspace)) throw new Error('Postmortem bukan milik workspace ini.')
  const directory = root(home, workspace)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  chmodSync(directory, 0o700)
  const target = join(directory, `${validated.startedAt}-${validated.id}.json`)
  const temporary = `${target}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  renameSync(temporary, target)
  chmodSync(target, 0o600)
  let names: string[] = []
  try { names = readdirSync(directory).filter((name) => name.endsWith('.json')).sort() } catch { /* Sudah tersimpan. */ }
  for (const name of names.slice(0, -MAX_POSTMORTEMS)) rmSync(join(directory, name), { force: true })
  return target
}

export function loadLatestFailurePostmortem(home: string, workspace: string): FailurePostmortemReport | null {
  const directory = root(home, workspace)
  let names: string[]
  try { names = readdirSync(directory).filter((name) => name.endsWith('.json')).sort().reverse() } catch { return null }
  for (const name of names.slice(0, MAX_POSTMORTEMS)) {
    try {
      const path = join(directory, name)
      if (lstatSync(path).isSymbolicLink() || !statSync(path).isFile() || statSync(path).size > MAX_POSTMORTEM_BYTES) continue
      const report = parseFailurePostmortem(JSON.parse(readFileSync(path, 'utf8')))
      if (report.workspaceId === workspaceId(workspace)) return report
    } catch { /* File rusak dilewati; laporan lebih lama masih dapat dipakai. */ }
  }
  return null
}

const EXPLANATION: Record<FailureCategory, { summary: string; action: string }> = {
  'provider-auth': { summary: 'Provider menolak autentikasi atau izin.', action: 'Periksa konfigurasi credential/provider dengan `boo-code doctor`, lalu coba ulang.' },
  'provider-rate-limit': { summary: 'Provider membatasi kapasitas atau kuota.', action: 'Periksa `/limit`, tunggu cooldown, atau pilih model/provider lain.' },
  'provider-unavailable': { summary: 'Model atau route provider tidak tersedia.', action: 'Gunakan mode Auto atau pilih model yang benar-benar tercantum di `/model`.' },
  'provider-context': { summary: 'Input melampaui kapasitas konteks model.', action: 'Gunakan `/compact`, kurangi attachment/konteks, atau pilih model dengan context lebih besar.' },
  'provider-request': { summary: 'Provider menolak bentuk request atau capability yang diminta.', action: 'Periksa dukungan tool, vision, dan reasoning model; mode Auto dapat memilih alternatif.' },
  'provider-transport': { summary: 'Koneksi provider gagal atau berhenti merespons.', action: 'Periksa koneksi/provider dengan `boo-code doctor`, lalu ulangi setelah layanan stabil.' },
  'tool-timeout': { summary: 'Tool tidak selesai dalam batas waktu aman.', action: 'Periksa state workspace/proses sebelum mengulang; pecah operasi atau gunakan background process bila sesuai.' },
  'tool-failure': { summary: 'Satu atau lebih tool gagal dan task tidak pulih.', action: 'Periksa tool yang tercantum, state workspace aktual, lalu ulangi langkah terkecil yang aman.' },
  'tool-denied': { summary: 'Aksi yang diperlukan tidak memperoleh izin.', action: 'Tinjau aksi dan kebijakan `/permissions`; izinkan hanya scope yang memang diperlukan.' },
  'tool-arguments': { summary: 'Model berulang kali menghasilkan argumen tool tidak valid.', action: 'Pilih model dengan tool calling lebih andal atau sederhanakan task menjadi langkah lebih kecil.' },
  'tool-loop': { summary: 'Agent mengulang aksi tanpa kemajuan dan dihentikan guard.', action: 'Periksa bukti terakhir, ubah pendekatan, dan lanjutkan dengan target yang lebih sempit.' },
  'tool-protocol': { summary: 'Function-call protocol model tetap tidak valid setelah recovery.', action: 'Pilih model dengan tool calling yang lebih andal atau gunakan mode Auto.' },
  verification: { summary: 'Perubahan belum memiliki verifikasi yang berhasil.', action: 'Periksa kegagalan test/diagnostic terakhir, perbaiki akar masalah, lalu jalankan verifikasi proporsional.' },
  'turn-limit': { summary: 'Task dihentikan setelah mencapai batas putaran.', action: 'Periksa `/status`, pecah sisa pekerjaan, lalu lanjutkan hanya langkah yang belum selesai.' },
  unknown: { summary: 'Task berhenti tanpa kategori akar masalah yang cukup kuat.', action: 'Periksa `/status`, workspace aktual, dan provider; lanjutkan dari bukti terakhir tanpa mengulang side effect secara buta.' },
}

export function formatFailurePostmortem(report: FailurePostmortemReport | null): string {
  if (!report) return 'Belum ada postmortem kegagalan untuk workspace ini.'
  const explanation = EXPLANATION[report.category]
  const evidence = [
    `${report.turns} turn`,
    `${report.retries} retry`,
    `${report.toolFailures}/${report.toolCalls} tool gagal`,
    report.toolDenied ? `${report.toolDenied} ditolak` : '',
    report.toolInvalid ? `${report.toolInvalid} argumen invalid` : '',
    report.toolTimeouts ? `${report.toolTimeouts} timeout` : '',
  ].filter(Boolean).join(' · ')
  return [
    `Postmortem · ${report.outcome} · ${report.category}`,
    explanation.summary,
    report.model ? `Model: ${report.model}${report.reasoningEffort ? ` · reasoning ${report.reasoningEffort}` : ''}` : '',
    `Bukti: ${evidence}`,
    report.failedTools.length ? `Tool terkait: ${report.failedTools.join(', ')}` : '',
    report.protocolKinds.length ? `Protocol: ${report.protocolKinds.join(', ')} · ${report.protocolFallbacks} fallback · ${report.protocolStops} berhenti` : '',
    report.verificationIncomplete ? `Verifikasi: belum tuntas · repair ${report.verificationRepairRounds} putaran · ${report.verificationRepairExhausted} kehabisan batas` : '',
    report.promptInjectionDetected ? 'Keamanan: sinyal prompt injection terdeteksi selama task.' : '',
    `Saran: ${explanation.action}`,
    'Privasi: laporan hanya memuat metadata kategorikal; prompt, source, argumen, output, dan path tidak disimpan.',
  ].filter(Boolean).join('\n')
}
