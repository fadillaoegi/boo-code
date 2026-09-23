/** Durable local scheduler for unattended Boo tasks. JSON only, no database. */

import { chmodSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'

export type ScheduleApproval = 'never' | 'workspace'
export type JobSchedule =
  | { kind: 'interval'; everyMinutes: number }
  | { kind: 'daily'; time: string }

export interface ScheduledJob {
  id: string
  prompt: string
  workspace: string
  schedule: JobSchedule
  approval: ScheduleApproval
  enabled: boolean
  createdAt: number
  updatedAt: number
  nextRunAt: number
  lastRunAt?: number
  lastExitCode?: number
  runs: number
  failures: number
}

export interface ScheduleFile { version: 1; jobs: ScheduledJob[] }
export interface ScheduleRun { jobId: string; startedAt: number; finishedAt: number; exitCode: number }

export const SCHEDULE_FILE = 'schedules.json'
export const SCHEDULE_RUNS_FILE = 'schedule-runs.jsonl'
export const SCHEDULER_LOCK_FILE = 'scheduler.lock'
export const MAX_SCHEDULED_JOBS = 100
const MAX_FILE_BYTES = 1024 * 1024
const MAX_PROMPT_LENGTH = 32_000
const MIN_INTERVAL_MINUTES = 1
const MAX_INTERVAL_MINUTES = 525_600

function storagePath(home: string, name: string): string { return join(home, '.boo', name) }

function validDailyTime(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)
}

function parseSchedule(value: unknown): JobSchedule | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as { kind?: unknown; everyMinutes?: unknown; time?: unknown }
  if (record.kind === 'interval' && typeof record.everyMinutes === 'number' && Number.isInteger(record.everyMinutes)
    && record.everyMinutes >= MIN_INTERVAL_MINUTES && record.everyMinutes <= MAX_INTERVAL_MINUTES) {
    return { kind: 'interval', everyMinutes: record.everyMinutes }
  }
  if (record.kind === 'daily' && validDailyTime(record.time)) return { kind: 'daily', time: record.time }
  return null
}

function parseJob(value: unknown): ScheduledJob | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const item = value as Record<string, unknown>
  const schedule = parseSchedule(item.schedule)
  if (typeof item.id !== 'string' || !/^[a-f0-9-]{8,64}$/i.test(item.id) || typeof item.prompt !== 'string'
    || !item.prompt.trim() || item.prompt.length > MAX_PROMPT_LENGTH || typeof item.workspace !== 'string'
    || !isAbsolute(item.workspace) || !schedule || (item.approval !== 'never' && item.approval !== 'workspace')
    || typeof item.enabled !== 'boolean' || typeof item.createdAt !== 'number' || typeof item.updatedAt !== 'number'
    || typeof item.nextRunAt !== 'number' || typeof item.runs !== 'number' || typeof item.failures !== 'number') return null
  return {
    id: item.id, prompt: item.prompt, workspace: item.workspace, schedule, approval: item.approval,
    enabled: item.enabled, createdAt: item.createdAt, updatedAt: item.updatedAt, nextRunAt: item.nextRunAt,
    ...(typeof item.lastRunAt === 'number' ? { lastRunAt: item.lastRunAt } : {}),
    ...(typeof item.lastExitCode === 'number' ? { lastExitCode: item.lastExitCode } : {}),
    runs: Math.max(0, Math.floor(item.runs)), failures: Math.max(0, Math.floor(item.failures)),
  }
}

export function loadSchedules(home = homedir()): ScheduleFile {
  try {
    const path = storagePath(home, SCHEDULE_FILE)
    const raw = readFileSync(path, 'utf8')
    if (Buffer.byteLength(raw) > MAX_FILE_BYTES) return { version: 1, jobs: [] }
    const parsed = JSON.parse(raw) as { version?: unknown; jobs?: unknown }
    if (parsed.version !== 1 || !Array.isArray(parsed.jobs)) return { version: 1, jobs: [] }
    return { version: 1, jobs: parsed.jobs.slice(0, MAX_SCHEDULED_JOBS).flatMap((item) => {
      const job = parseJob(item)
      return job ? [job] : []
    }) }
  } catch {
    return { version: 1, jobs: [] }
  }
}

export function saveSchedules(file: ScheduleFile, home = homedir()): void {
  const path = storagePath(home, SCHEDULE_FILE)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify({ version: 1, jobs: file.jobs.slice(0, MAX_SCHEDULED_JOBS) }, null, 2)}\n`, { mode: 0o600 })
  chmodSync(temporary, 0o600)
  renameSync(temporary, path)
  chmodSync(path, 0o600)
}

export function nextRun(schedule: JobSchedule, after = Date.now()): number {
  if (schedule.kind === 'interval') return after + schedule.everyMinutes * 60_000
  const [hour, minute] = schedule.time.split(':').map(Number)
  const next = new Date(after)
  next.setHours(hour, minute, 0, 0)
  if (next.getTime() <= after) next.setDate(next.getDate() + 1)
  return next.getTime()
}

export function addSchedule(input: {
  prompt: string
  workspace: string
  schedule: JobSchedule
  approval?: ScheduleApproval
  now?: number
}, home = homedir()): ScheduledJob {
  const prompt = input.prompt.trim()
  if (!prompt || prompt.length > MAX_PROMPT_LENGTH) throw new Error(`Prompt jadwal harus 1–${MAX_PROMPT_LENGTH} karakter.`)
  if (!isAbsolute(input.workspace)) throw new Error('Workspace jadwal harus berupa path absolut.')
  if (!parseSchedule(input.schedule)) throw new Error('Jadwal tidak sah.')
  const file = loadSchedules(home)
  if (file.jobs.length >= MAX_SCHEDULED_JOBS) throw new Error(`Maksimal ${MAX_SCHEDULED_JOBS} task terjadwal.`)
  const now = input.now ?? Date.now()
  const job: ScheduledJob = {
    id: randomUUID(), prompt, workspace: input.workspace, schedule: input.schedule,
    approval: input.approval ?? 'never', enabled: true, createdAt: now, updatedAt: now,
    nextRunAt: nextRun(input.schedule, now), runs: 0, failures: 0,
  }
  file.jobs.push(job)
  saveSchedules(file, home)
  return job
}

export function removeSchedule(id: string, home = homedir()): boolean {
  const file = loadSchedules(home)
  const next = file.jobs.filter((job) => job.id !== id)
  if (next.length === file.jobs.length) return false
  saveSchedules({ version: 1, jobs: next }, home)
  return true
}

export function setScheduleEnabled(id: string, enabled: boolean, home = homedir(), now = Date.now()): ScheduledJob | null {
  const file = loadSchedules(home)
  const job = file.jobs.find((candidate) => candidate.id === id)
  if (!job) return null
  job.enabled = enabled
  job.updatedAt = now
  if (enabled) job.nextRunAt = nextRun(job.schedule, now)
  saveSchedules(file, home)
  return job
}

/** Claim dilakukan sebelum task berjalan agar dua tick tidak menjalankan job sama. */
export function claimDueSchedules(home = homedir(), now = Date.now(), limit = 1): ScheduledJob[] {
  const file = loadSchedules(home)
  const due = file.jobs.filter((job) => job.enabled && job.nextRunAt <= now).sort((a, b) => a.nextRunAt - b.nextRunAt).slice(0, Math.max(1, limit))
  for (const job of due) {
    job.lastRunAt = now
    job.updatedAt = now
    job.nextRunAt = nextRun(job.schedule, now)
  }
  if (due.length) saveSchedules(file, home)
  return due.map((job) => ({ ...job, schedule: { ...job.schedule } }))
}

export function finishScheduleRun(id: string, exitCode: number, startedAt: number, home = homedir(), finishedAt = Date.now()): void {
  const file = loadSchedules(home)
  const job = file.jobs.find((candidate) => candidate.id === id)
  if (job) {
    job.runs += 1
    if (exitCode !== 0) job.failures += 1
    job.lastExitCode = exitCode
    job.updatedAt = finishedAt
    saveSchedules(file, home)
  }
  const path = storagePath(home, SCHEDULE_RUNS_FILE)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const previous = (() => { try { return readFileSync(path, 'utf8') } catch { return '' } })()
  const lines = previous.split('\n').filter(Boolean).slice(-199)
  lines.push(JSON.stringify({ jobId: id, startedAt, finishedAt, exitCode } satisfies ScheduleRun))
  writeFileSync(path, `${lines.join('\n')}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)
}

export function acquireSchedulerLock(home = homedir()): () => void {
  const path = storagePath(home, SCHEDULER_LOCK_FILE)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  let descriptor: number
  const create = () => {
    descriptor = openSync(path, 'wx', 0o600)
    writeFileSync(descriptor, `${process.pid}\n`)
  }
  try { create() } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error('Lock scheduler tidak dapat dibuat.', { cause: error })
    let stale = false
    try {
      const pid = Number(readFileSync(path, 'utf8').trim())
      if (!Number.isSafeInteger(pid) || pid <= 0) stale = true
      else {
        try { process.kill(pid, 0) } catch (probe) {
          const code = (probe as NodeJS.ErrnoException).code
          stale = code === 'ESRCH'
        }
      }
    } catch { stale = true }
    if (!stale) throw new Error('Scheduler Boo lain sudah berjalan.', { cause: error })
    try { unlinkSync(path); create() } catch (retry) { throw new Error('Lock scheduler basi tidak dapat dipulihkan.', { cause: retry }) }
  }
  let released = false
  return () => {
    if (released) return
    released = true
    try { closeSync(descriptor) } catch { /* sudah tertutup */ }
    try { unlinkSync(path) } catch { /* sudah hilang */ }
  }
}

export function describeSchedule(schedule: JobSchedule): string {
  return schedule.kind === 'interval' ? `setiap ${schedule.everyMinutes} menit` : `setiap hari ${schedule.time}`
}

export function parseScheduleDuration(value: string): number | null {
  const match = /^(\d+)(m|h|d)$/.exec(value.trim().toLowerCase())
  if (!match) return null
  const multiplier = match[2] === 'm' ? 1 : match[2] === 'h' ? 60 : 1_440
  const minutes = Number(match[1]) * multiplier
  return Number.isSafeInteger(minutes) && minutes >= MIN_INTERVAL_MINUTES && minutes <= MAX_INTERVAL_MINUTES ? minutes : null
}
