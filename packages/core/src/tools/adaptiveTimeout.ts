/** Kebijakan timeout command yang belajar dari metrik agregat tanpa menyimpan command. */

import { randomUUID } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const TOOL_TIMEOUT_SCHEMA_VERSION = 1
export const TOOL_TIMEOUT_PROFILE_PATH = '.boo/tool-timeouts.json'
export const MIN_TOOL_TIMEOUT_SECONDS = 1
export const MAX_TOOL_TIMEOUT_SECONDS = 600
export const TOOL_TIMEOUT_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1_000
const MAX_PROFILE_BYTES = 128 * 1024
const MAX_SAMPLES = 200

export type CommandTimeoutCategory = 'quick' | 'test' | 'build' | 'install' | 'network' | 'long-running' | 'general'

export interface ToolTimeoutStat {
  category: CommandTimeoutCategory
  samples: number
  timeouts: number
  averageMs: number
  maximumMs: number
  timeoutFloorMs: number
  updatedAt: number
}

export interface ToolTimeoutProfile {
  schemaVersion: 1
  updatedAt: number
  stats: ToolTimeoutStat[]
}

export interface AdaptiveTimeoutSelection {
  category: CommandTimeoutCategory
  mode: 'explicit' | 'adaptive'
  /** Batas tanpa keluaran baru. Pada mode eksplisit ini juga menjadi hard limit. */
  idleSeconds: number
  /** Batas total absolut walaupun command terus menghasilkan keluaran. */
  maximumSeconds: number
  learnedSamples: number
  reason: string
}

const DEFAULT_SECONDS: Record<CommandTimeoutCategory, number> = {
  quick: 45,
  test: 180,
  build: 300,
  install: 300,
  network: 120,
  'long-running': 45,
  general: 120,
}

const CATEGORIES = new Set<CommandTimeoutCategory>(Object.keys(DEFAULT_SECONDS) as CommandTimeoutCategory[])

function boundedSeconds(value: number): number {
  return Math.min(MAX_TOOL_TIMEOUT_SECONDS, Math.max(MIN_TOOL_TIMEOUT_SECONDS, Math.round(value)))
}

/** Klasifikasi hanya memakai proses pertama/flag umum; teks command tidak pernah dipersistenkan. */
export function classifyCommandTimeout(command: string): CommandTimeoutCategory {
  const normalized = command.trim().toLowerCase()
  if (/\b(?:dev|serve|watch)(?=\s|$)|--watch\b|watch(?:er)?\b/.test(normalized)) return 'long-running'
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|update)\b|\b(?:pip|pip3)\s+install\b|\b(?:bundle|pod)\s+install\b|\bflutter\s+pub\s+get\b/.test(normalized)) return 'install'
  if (/\b(?:test|pytest|vitest|jest|mocha|rspec)\b|\bgo\s+test\b|\bcargo\s+test\b|\bflutter\s+test\b|\bnode\s+--test\b/.test(normalized)) return 'test'
  if (/\b(?:build|compile|typecheck|lint|analyze|check)\b|\b(?:tsc|gofmt|cargo\s+check)\b/.test(normalized)) return 'build'
  if (/\b(?:curl|wget|ssh|scp|rsync)\b|\bgit\s+(?:clone|fetch|pull|push)\b/.test(normalized)) return 'network'
  if (/^(?:pwd|ls|find|rg|grep|git\s+(?:status|diff|log|show|blame)\b)/.test(normalized)) return 'quick'
  return 'general'
}

function emptyProfile(now = Date.now()): ToolTimeoutProfile {
  return { schemaVersion: TOOL_TIMEOUT_SCHEMA_VERSION, updatedAt: now, stats: [] }
}

function finite(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum
}

export function parseToolTimeoutProfile(value: unknown): ToolTimeoutProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Profil timeout harus berupa object.')
  const input = value as Record<string, unknown>
  if (input.schemaVersion !== TOOL_TIMEOUT_SCHEMA_VERSION || !finite(input.updatedAt) || !Array.isArray(input.stats)) {
    throw new Error('Profil timeout tidak valid.')
  }
  const seen = new Set<string>()
  const stats = input.stats.map((raw): ToolTimeoutStat => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Statistik timeout tidak valid.')
    const item = raw as Record<string, unknown>
    if (typeof item.category !== 'string' || !CATEGORIES.has(item.category as CommandTimeoutCategory) || seen.has(item.category)) {
      throw new Error('Kategori timeout tidak valid atau duplikat.')
    }
    if (![item.samples, item.timeouts, item.averageMs, item.maximumMs, item.timeoutFloorMs, item.updatedAt].every((number) => finite(number))) {
      throw new Error('Nilai statistik timeout tidak valid.')
    }
    if (!Number.isInteger(item.samples) || !Number.isInteger(item.timeouts)
      || (item.samples as number) < 1 || (item.samples as number) > MAX_SAMPLES
      || (item.timeouts as number) > (item.samples as number)) throw new Error('Jumlah statistik timeout tidak valid.')
    seen.add(item.category)
    return {
      category: item.category as CommandTimeoutCategory,
      samples: item.samples as number,
      timeouts: item.timeouts as number,
      averageMs: item.averageMs as number,
      maximumMs: item.maximumMs as number,
      timeoutFloorMs: item.timeoutFloorMs as number,
      updatedAt: item.updatedAt as number,
    }
  })
  return { schemaVersion: TOOL_TIMEOUT_SCHEMA_VERSION, updatedAt: input.updatedAt, stats }
}

export function toolTimeoutProfileFile(home: string): string {
  return join(home, TOOL_TIMEOUT_PROFILE_PATH)
}

/** Profil hilang, rusak, terlalu besar, atau berupa symlink diabaikan dengan aman. */
export function loadToolTimeoutProfile(home: string): ToolTimeoutProfile {
  const path = toolTimeoutProfileFile(home)
  try {
    if (lstatSync(path).isSymbolicLink() || statSync(path).size > MAX_PROFILE_BYTES) return emptyProfile()
    return parseToolTimeoutProfile(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return emptyProfile()
  }
}

export function saveToolTimeoutProfile(home: string, profile: ToolTimeoutProfile): string {
  const directory = join(home, '.boo')
  const path = toolTimeoutProfileFile(home)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  chmodSync(directory, 0o700)
  const temporary = `${path}.${process.pid}-${randomUUID()}.tmp`
  writeFileSync(temporary, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, path)
  chmodSync(path, 0o600)
  return path
}

export function selectAdaptiveTimeout(command: string, requested: unknown, profile?: ToolTimeoutProfile, now = Date.now()): AdaptiveTimeoutSelection {
  const category = classifyCommandTimeout(command)
  if (typeof requested === 'number' && Number.isFinite(requested)) {
    const seconds = boundedSeconds(requested)
    return {
      category,
      mode: 'explicit',
      idleSeconds: seconds,
      maximumSeconds: seconds,
      learnedSamples: 0,
      reason: `timeout eksplisit ${seconds} detik`,
    }
  }
  const stat = profile?.stats.find((item) => item.category === category && now - item.updatedAt <= TOOL_TIMEOUT_MAX_AGE_MS)
  const base = DEFAULT_SECONDS[category]
  const learned = stat
    ? Math.ceil(Math.max(
      stat.timeouts < stat.samples ? stat.averageMs * 3 : 0,
      stat.timeouts < stat.samples ? stat.maximumMs * 1.5 : 0,
      stat.timeoutFloorMs,
    ) / 1_000)
    : 0
  const idleSeconds = boundedSeconds(Math.max(base, learned))
  const maximumSeconds = boundedSeconds(Math.max(idleSeconds, idleSeconds * 2))
  return {
    category,
    mode: 'adaptive',
    idleSeconds,
    maximumSeconds,
    learnedSamples: stat?.samples ?? 0,
    reason: stat
      ? `${category}; ${stat.samples} sampel lokal; idle ${idleSeconds}s, maksimum ${maximumSeconds}s`
      : `${category}; kebijakan awal; idle ${idleSeconds}s, maksimum ${maximumSeconds}s`,
  }
}

/** Memperbarui agregat durasi; tidak menerima maupun menyimpan teks command. */
export function recordToolTimeoutObservation(
  profile: ToolTimeoutProfile | undefined,
  category: CommandTimeoutCategory,
  durationMs: number,
  timedOut: boolean,
  now = Date.now(),
): ToolTimeoutProfile {
  const next: ToolTimeoutProfile = profile
    ? { ...profile, stats: profile.stats.map((item) => ({ ...item })) }
    : emptyProfile(now)
  let stat = next.stats.find((item) => item.category === category)
  if (!stat) {
    stat = { category, samples: 0, timeouts: 0, averageMs: 0, maximumMs: 0, timeoutFloorMs: 0, updatedAt: now }
    next.stats.push(stat)
  }
  if (stat.samples >= MAX_SAMPLES) {
    stat.samples = Math.max(1, Math.round(stat.samples / 2))
    stat.timeouts = Math.round(stat.timeouts / 2)
  }
  const observed = Math.max(0, Math.round(durationMs))
  stat.averageMs = stat.samples ? ((stat.averageMs * stat.samples) + observed) / (stat.samples + 1) : observed
  stat.maximumMs = Math.max(stat.maximumMs * 0.98, observed)
  stat.samples += 1
  stat.timeouts += timedOut ? 1 : 0
  if (timedOut) stat.timeoutFloorMs = Math.min(MAX_TOOL_TIMEOUT_SECONDS * 1_000, Math.max(stat.timeoutFloorMs, observed * 1.5))
  else stat.timeoutFloorMs = stat.timeoutFloorMs < 1_000 ? 0 : stat.timeoutFloorMs * 0.95
  stat.updatedAt = now
  next.updatedAt = now
  next.stats.sort((a, b) => a.category.localeCompare(b.category))
  return next
}

const profiles = new Map<string, ToolTimeoutProfile>()

export function adaptiveTimeoutProfile(home: string | undefined): ToolTimeoutProfile | undefined {
  if (!home) return undefined
  let profile = profiles.get(home)
  if (!profile) {
    profile = loadToolTimeoutProfile(home)
    profiles.set(home, profile)
  }
  return profile
}

export function rememberAdaptiveTimeout(
  home: string | undefined,
  category: CommandTimeoutCategory,
  durationMs: number,
  timedOut: boolean,
): ToolTimeoutProfile | undefined {
  if (!home) return undefined
  const profile = recordToolTimeoutObservation(adaptiveTimeoutProfile(home), category, durationMs, timedOut)
  profiles.set(home, profile)
  try { saveToolTimeoutProfile(home, profile) } catch { /* pembelajaran tidak boleh menggagalkan command */ }
  return profile
}
