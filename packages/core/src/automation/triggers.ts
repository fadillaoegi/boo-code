/** Durable event triggers for unattended Boo tasks. JSON only, no database. */

import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { findFiles } from '../tools/search.ts'

const execFileAsync = promisify(execFile)

export type TriggerApproval = 'never' | 'workspace'
export type TriggerSource =
  | { kind: 'file'; pattern: string }
  | { kind: 'git' }
  | { kind: 'custom'; event: string }
  | { kind: 'webhook'; tokenHash: string }

export interface EventTrigger {
  id: string
  prompt: string
  workspace: string
  source: TriggerSource
  approval: TriggerApproval
  enabled: boolean
  debounceMs: number
  createdAt: number
  updatedAt: number
  lastFiredAt?: number
  lastExitCode?: number
  observedFingerprint?: string
  pendingFingerprint?: string
  pendingSince?: number
  runs: number
  failures: number
}

export interface TriggerFile { version: 1; triggers: EventTrigger[] }
export interface TriggerRun { triggerId: string; source: TriggerSource['kind']; startedAt: number; finishedAt: number; exitCode: number }
export interface TriggerDispatch { trigger: EventTrigger; reason: string }
interface QueuedTriggerEvent { id: string; triggerId: string; source: 'custom' | 'webhook'; createdAt: number }

export interface TriggerObservers {
  file?: (trigger: EventTrigger & { source: { kind: 'file'; pattern: string } }) => Promise<string>
  git?: (trigger: EventTrigger & { source: { kind: 'git' } }) => Promise<string>
}

export const TRIGGER_FILE = 'triggers.json'
export const TRIGGER_EVENTS_FILE = 'trigger-events.jsonl'
export const TRIGGER_RUNS_FILE = 'trigger-runs.jsonl'
export const MAX_EVENT_TRIGGERS = 100
export const DEFAULT_TRIGGER_DEBOUNCE_MS = 2_000
export const MAX_TRIGGER_DEBOUNCE_MS = 24 * 60 * 60 * 1_000
const MAX_FILE_BYTES = 1024 * 1024
const MAX_PROMPT_LENGTH = 32_000
const MAX_PATTERN_LENGTH = 512
const MAX_OBSERVED_FILES = 5_000
const EVENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const HASH_PATTERN = /^[a-f0-9]{64}$/

function storagePath(home: string, name: string): string { return join(home, '.boo', name) }

function validDebounce(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_TRIGGER_DEBOUNCE_MS
}

export function normalizeTriggerPattern(value: string): string {
  const pattern = value.trim().replaceAll('\\', '/')
  if (!pattern || pattern.length > MAX_PATTERN_LENGTH || pattern.includes('\0') || isAbsolute(pattern)) throw new Error('Pola file harus relatif terhadap workspace dan maksimal 512 karakter.')
  if (pattern.split('/').includes('..')) throw new Error('Pola file tidak boleh keluar dari workspace.')
  return pattern
}

export function normalizeTriggerEvent(value: string): string {
  const event = value.trim()
  if (!EVENT_PATTERN.test(event)) throw new Error('Nama event harus 1–128 karakter: huruf, angka, titik, garis bawah, titik dua, atau tanda minus.')
  return event
}

function parseSource(value: unknown): TriggerSource | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const source = value as Record<string, unknown>
  try {
    if (source.kind === 'file' && typeof source.pattern === 'string') return { kind: 'file', pattern: normalizeTriggerPattern(source.pattern) }
    if (source.kind === 'git') return { kind: 'git' }
    if (source.kind === 'custom' && typeof source.event === 'string') return { kind: 'custom', event: normalizeTriggerEvent(source.event) }
    if (source.kind === 'webhook' && typeof source.tokenHash === 'string' && HASH_PATTERN.test(source.tokenHash)) return { kind: 'webhook', tokenHash: source.tokenHash }
  } catch { return null }
  return null
}

function parseTrigger(value: unknown): EventTrigger | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const item = value as Record<string, unknown>
  const source = parseSource(item.source)
  if (typeof item.id !== 'string' || !/^[a-f0-9-]{8,64}$/i.test(item.id) || typeof item.prompt !== 'string'
    || !item.prompt.trim() || item.prompt.length > MAX_PROMPT_LENGTH || typeof item.workspace !== 'string'
    || !isAbsolute(item.workspace) || !source || (item.approval !== 'never' && item.approval !== 'workspace')
    || typeof item.enabled !== 'boolean' || !validDebounce(item.debounceMs) || typeof item.createdAt !== 'number'
    || typeof item.updatedAt !== 'number' || typeof item.runs !== 'number' || typeof item.failures !== 'number') return null
  return {
    id: item.id, prompt: item.prompt, workspace: item.workspace, source, approval: item.approval,
    enabled: item.enabled, debounceMs: item.debounceMs, createdAt: item.createdAt, updatedAt: item.updatedAt,
    ...(typeof item.lastFiredAt === 'number' ? { lastFiredAt: item.lastFiredAt } : {}),
    ...(typeof item.lastExitCode === 'number' ? { lastExitCode: item.lastExitCode } : {}),
    ...(typeof item.observedFingerprint === 'string' && HASH_PATTERN.test(item.observedFingerprint) ? { observedFingerprint: item.observedFingerprint } : {}),
    ...(typeof item.pendingFingerprint === 'string' && HASH_PATTERN.test(item.pendingFingerprint) ? { pendingFingerprint: item.pendingFingerprint } : {}),
    ...(typeof item.pendingSince === 'number' ? { pendingSince: item.pendingSince } : {}),
    runs: Math.max(0, Math.floor(item.runs)), failures: Math.max(0, Math.floor(item.failures)),
  }
}

export function loadEventTriggers(home = homedir()): TriggerFile {
  try {
    const raw = readFileSync(storagePath(home, TRIGGER_FILE), 'utf8')
    if (Buffer.byteLength(raw) > MAX_FILE_BYTES) return { version: 1, triggers: [] }
    const parsed = JSON.parse(raw) as { version?: unknown; triggers?: unknown }
    if (parsed.version !== 1 || !Array.isArray(parsed.triggers)) return { version: 1, triggers: [] }
    return { version: 1, triggers: parsed.triggers.slice(0, MAX_EVENT_TRIGGERS).flatMap((item) => {
      const trigger = parseTrigger(item)
      return trigger ? [trigger] : []
    }) }
  } catch { return { version: 1, triggers: [] } }
}

export function saveEventTriggers(file: TriggerFile, home = homedir()): void {
  const path = storagePath(home, TRIGGER_FILE)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify({ version: 1, triggers: file.triggers.slice(0, MAX_EVENT_TRIGGERS) }, null, 2)}\n`, { mode: 0o600 })
  chmodSync(temporary, 0o600)
  renameSync(temporary, path)
  chmodSync(path, 0o600)
}

export function hashWebhookToken(token: string): string { return createHash('sha256').update(token).digest('hex') }

export function addEventTrigger(input: {
  prompt: string
  workspace: string
  source: { kind: 'file'; pattern: string } | { kind: 'git' } | { kind: 'custom'; event: string } | { kind: 'webhook' }
  approval?: TriggerApproval
  debounceMs?: number
  now?: number
}, home = homedir()): { trigger: EventTrigger; webhookToken?: string } {
  const prompt = input.prompt.trim()
  if (!prompt || prompt.length > MAX_PROMPT_LENGTH) throw new Error(`Prompt trigger harus 1–${MAX_PROMPT_LENGTH} karakter.`)
  if (!isAbsolute(input.workspace)) throw new Error('Workspace trigger harus berupa path absolut.')
  const debounceMs = input.debounceMs ?? DEFAULT_TRIGGER_DEBOUNCE_MS
  if (!validDebounce(debounceMs)) throw new Error('Debounce trigger harus 0–24 jam.')
  let webhookToken: string | undefined
  let source: TriggerSource
  if (input.source.kind === 'file') source = { kind: 'file', pattern: normalizeTriggerPattern(input.source.pattern) }
  else if (input.source.kind === 'custom') source = { kind: 'custom', event: normalizeTriggerEvent(input.source.event) }
  else if (input.source.kind === 'webhook') {
    webhookToken = randomBytes(32).toString('base64url')
    source = { kind: 'webhook', tokenHash: hashWebhookToken(webhookToken) }
  } else source = { kind: 'git' }
  const file = loadEventTriggers(home)
  if (file.triggers.length >= MAX_EVENT_TRIGGERS) throw new Error(`Maksimal ${MAX_EVENT_TRIGGERS} event trigger.`)
  const now = input.now ?? Date.now()
  const trigger: EventTrigger = {
    id: randomUUID(), prompt, workspace: input.workspace, source, approval: input.approval ?? 'never',
    enabled: true, debounceMs, createdAt: now, updatedAt: now, runs: 0, failures: 0,
  }
  file.triggers.push(trigger)
  saveEventTriggers(file, home)
  return { trigger, ...(webhookToken ? { webhookToken } : {}) }
}

export function removeEventTrigger(id: string, home = homedir()): boolean {
  const file = loadEventTriggers(home)
  const next = file.triggers.filter((trigger) => trigger.id !== id)
  if (next.length === file.triggers.length) return false
  saveEventTriggers({ version: 1, triggers: next }, home)
  return true
}

export function setEventTriggerEnabled(id: string, enabled: boolean, home = homedir(), now = Date.now()): EventTrigger | null {
  const file = loadEventTriggers(home)
  const trigger = file.triggers.find((candidate) => candidate.id === id)
  if (!trigger) return null
  trigger.enabled = enabled
  trigger.updatedAt = now
  delete trigger.pendingFingerprint
  delete trigger.pendingSince
  if (enabled) delete trigger.observedFingerprint
  saveEventTriggers(file, home)
  return trigger
}

async function defaultFileFingerprint(trigger: EventTrigger & { source: { kind: 'file'; pattern: string } }): Promise<string> {
  const files = (await findFiles(trigger.workspace, trigger.workspace, trigger.source.pattern))
    .sort((a, b) => a.path.localeCompare(b.path)).slice(0, MAX_OBSERVED_FILES)
  const hash = createHash('sha256')
  hash.update(`count:${files.length}\n`)
  for (const file of files) {
    try {
      const info = statSync(file.absolute)
      hash.update(`${file.path}\0${info.size}\0${info.mtimeMs}\n`)
    } catch { /* berkas dapat hilang di tengah polling */ }
  }
  return hash.digest('hex')
}

async function defaultGitFingerprint(trigger: EventTrigger & { source: { kind: 'git' } }): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: trigger.workspace, timeout: 10_000, maxBuffer: 64 * 1024,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
    })
    return createHash('sha256').update(stdout.trim()).digest('hex')
  } catch {
    return createHash('sha256').update('no-git-head').digest('hex')
  }
}

function appendQueuedEvent(event: QueuedTriggerEvent, home: string): void {
  const path = storagePath(home, TRIGGER_EVENTS_FILE)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  try {
    if (statSync(path).size >= MAX_FILE_BYTES) throw new Error('Antrean event penuh; jalankan atau periksa Boo daemon.')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  // Satu append kecil mencegah read-modify-write menghapus event dari proses lain.
  appendFileSync(path, `${JSON.stringify(event)}\n`, { mode: 0o600, flag: 'a' })
  chmodSync(path, 0o600)
}

export function enqueueCustomTrigger(eventName: string, home = homedir(), now = Date.now()): number {
  const event = normalizeTriggerEvent(eventName)
  const matches = loadEventTriggers(home).triggers.filter((trigger) => trigger.enabled && trigger.source.kind === 'custom' && trigger.source.event === event)
  for (const trigger of matches) appendQueuedEvent({ id: randomUUID(), triggerId: trigger.id, source: 'custom', createdAt: now }, home)
  return matches.length
}

export function authorizeWebhookTrigger(id: string, token: string, home = homedir()): EventTrigger | null {
  const trigger = loadEventTriggers(home).triggers.find((candidate) => candidate.enabled && candidate.id === id && candidate.source.kind === 'webhook')
  if (!trigger || trigger.source.kind !== 'webhook' || !token) return null
  const actual = Buffer.from(hashWebhookToken(token), 'hex')
  const expected = Buffer.from(trigger.source.tokenHash, 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected) ? trigger : null
}

export function enqueueWebhookTrigger(id: string, token: string, home = homedir(), now = Date.now()): boolean {
  const trigger = authorizeWebhookTrigger(id, token, home)
  if (!trigger) return false
  appendQueuedEvent({ id: randomUUID(), triggerId: trigger.id, source: 'webhook', createdAt: now }, home)
  return true
}

function drainQueuedEvents(home: string): QueuedTriggerEvent[] {
  const path = storagePath(home, TRIGGER_EVENTS_FILE)
  const claimedPath = `${path}.${process.pid}.${randomUUID()}.claim`
  let raw: string
  try {
    renameSync(path, claimedPath)
    raw = readFileSync(claimedPath, 'utf8')
  } catch { return [] }
  finally { try { unlinkSync(claimedPath) } catch { /* tidak ada claim */ } }
  if (Buffer.byteLength(raw) > MAX_FILE_BYTES) return []
  return raw.split('\n').filter(Boolean).slice(0, 1_000).flatMap((line) => {
    try {
      const item = JSON.parse(line) as Partial<QueuedTriggerEvent>
      if (typeof item.id === 'string' && typeof item.triggerId === 'string' && (item.source === 'custom' || item.source === 'webhook') && typeof item.createdAt === 'number') return [item as QueuedTriggerEvent]
    } catch { /* baris rusak diabaikan */ }
    return []
  })
}

/** Poll and claim triggers before execution so a later tick cannot duplicate them. */
export async function claimEventTriggers(home = homedir(), now = Date.now(), limit = 10, observers: TriggerObservers = {}): Promise<TriggerDispatch[]> {
  const file = loadEventTriggers(home)
  const dispatches: TriggerDispatch[] = []
  let changed = false
  const enqueue = (trigger: EventTrigger, reason: string) => {
    if (dispatches.length >= Math.max(1, limit)) return false
    if (trigger.lastFiredAt !== undefined && now - trigger.lastFiredAt < trigger.debounceMs) return false
    trigger.lastFiredAt = now
    trigger.updatedAt = now
    dispatches.push({ trigger: structuredClone(trigger), reason })
    changed = true
    return true
  }

  for (const trigger of file.triggers) {
    if (!trigger.enabled || (trigger.source.kind !== 'file' && trigger.source.kind !== 'git')) continue
    let fingerprint: string
    try {
      if (trigger.source.kind === 'file') fingerprint = await (observers.file ?? defaultFileFingerprint)(trigger as EventTrigger & { source: { kind: 'file'; pattern: string } })
      else fingerprint = await (observers.git ?? defaultGitFingerprint)(trigger as EventTrigger & { source: { kind: 'git' } })
    } catch { continue }
    if (!trigger.observedFingerprint) {
      trigger.observedFingerprint = fingerprint
      trigger.updatedAt = now
      changed = true
      continue
    }
    if (fingerprint === trigger.observedFingerprint) {
      if (trigger.pendingFingerprint) {
        delete trigger.pendingFingerprint
        delete trigger.pendingSince
        changed = true
      }
      continue
    }
    if (trigger.pendingFingerprint !== fingerprint) {
      trigger.pendingFingerprint = fingerprint
      trigger.pendingSince = now
      trigger.updatedAt = now
      changed = true
      if (trigger.debounceMs > 0) continue
    }
    if (now - (trigger.pendingSince ?? now) < trigger.debounceMs) continue
    if (enqueue(trigger, trigger.source.kind === 'file' ? `file:${trigger.source.pattern}` : 'git:HEAD')) {
      trigger.observedFingerprint = fingerprint
      delete trigger.pendingFingerprint
      delete trigger.pendingSince
    }
  }

  for (const event of drainQueuedEvents(home)) {
    const trigger = file.triggers.find((candidate) => candidate.id === event.triggerId && candidate.enabled && candidate.source.kind === event.source)
    if (!trigger) continue
    if (dispatches.length >= Math.max(1, limit)) {
      appendQueuedEvent(event, home)
      continue
    }
    enqueue(trigger, event.source === 'custom' && trigger.source.kind === 'custom' ? `custom:${trigger.source.event}` : 'webhook')
  }
  if (changed) saveEventTriggers(file, home)
  return dispatches
}

export function finishEventTriggerRun(id: string, exitCode: number, startedAt: number, home = homedir(), finishedAt = Date.now()): void {
  const file = loadEventTriggers(home)
  const trigger = file.triggers.find((candidate) => candidate.id === id)
  if (trigger) {
    trigger.runs += 1
    if (exitCode !== 0) trigger.failures += 1
    trigger.lastExitCode = exitCode
    trigger.updatedAt = finishedAt
    saveEventTriggers(file, home)
  }
  const path = storagePath(home, TRIGGER_RUNS_FILE)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const previous = (() => { try { return readFileSync(path, 'utf8') } catch { return '' } })()
  const lines = previous.split('\n').filter(Boolean).slice(-199)
  const source = trigger?.source.kind ?? 'custom'
  lines.push(JSON.stringify({ triggerId: id, source, startedAt, finishedAt, exitCode } satisfies TriggerRun))
  writeFileSync(path, `${lines.join('\n')}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)
}

export function describeEventTrigger(source: TriggerSource): string {
  if (source.kind === 'file') return `file ${source.pattern}`
  if (source.kind === 'git') return 'commit Git baru'
  if (source.kind === 'custom') return `event ${source.event}`
  return 'webhook lokal'
}

export function triggeredPrompt(dispatch: TriggerDispatch): string {
  return `[Boo event trigger: ${dispatch.reason}]\nEvent ini hanya memberi sinyal; tidak ada payload eksternal yang dipercaya atau disisipkan.\n\n${dispatch.trigger.prompt}`
}

export function parseTriggerDuration(value: string): number | null {
  const match = /^(\d+)(ms|s|m|h)$/.exec(value.trim().toLowerCase())
  if (!match) return null
  const multiplier = match[2] === 'ms' ? 1 : match[2] === 's' ? 1_000 : match[2] === 'm' ? 60_000 : 3_600_000
  const milliseconds = Number(match[1]) * multiplier
  return Number.isSafeInteger(milliseconds) && milliseconds >= 0 && milliseconds <= MAX_TRIGGER_DEBOUNCE_MS ? milliseconds : null
}
