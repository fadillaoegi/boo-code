/** Profil performa model dari benchmark lokal; tidak menyimpan prompt atau source. */

import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { EvalRunReport } from '../eval/benchmark.ts'
import type { TaskDifficulty } from './auto.ts'
import type { EffortOption } from './models.ts'

export const AUTO_PERFORMANCE_SCHEMA_VERSION = 1
export const AUTO_PERFORMANCE_PATH = '.boo/auto-performance.json'
export const AUTO_PERFORMANCE_MIN_SAMPLES = 3
export const AUTO_PERFORMANCE_MAX_AGE_MS = 45 * 24 * 60 * 60 * 1_000
const MAX_PROFILE_BYTES = 1024 * 1024
const MAX_STATS = 5_000
const MAX_SAMPLES_PER_STAT = 200
const DIFFICULTIES = new Set<TaskDifficulty>(['simple', 'standard', 'complex', 'expert'])

export interface AutoPerformanceStat {
  model: string
  reasoningEffort?: string
  difficulty: TaskDifficulty
  /** `*` adalah agregat umum; nilai lain berasal dari tag kasus benchmark. */
  tag: string
  samples: number
  passes: number
  scoreTotal: number
  durationMsTotal: number
  retries: number
  toolFailures: number
  updatedAt: number
}

export interface AutoPerformanceProfile {
  schemaVersion: 1
  updatedAt: number
  stats: AutoPerformanceStat[]
}

export interface PerformanceSelection {
  option: EffortOption
  samples: number
  quality: number
}

function finite(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum
}

function parseStat(value: unknown): AutoPerformanceStat | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const item = value as Record<string, unknown>
  if (typeof item.model !== 'string' || !item.model || typeof item.tag !== 'string' || !item.tag) return null
  if (typeof item.difficulty !== 'string' || !DIFFICULTIES.has(item.difficulty as TaskDifficulty)) return null
  if (item.reasoningEffort !== undefined && typeof item.reasoningEffort !== 'string') return null
  if (![item.samples, item.passes, item.scoreTotal, item.durationMsTotal, item.retries, item.toolFailures, item.updatedAt].every((number) => finite(number))) return null
  if ((item.samples as number) < 1 || (item.passes as number) > (item.samples as number) || (item.scoreTotal as number) > (item.samples as number) * 100) return null
  return {
    model: item.model,
    ...(item.reasoningEffort ? { reasoningEffort: item.reasoningEffort as string } : {}),
    difficulty: item.difficulty as TaskDifficulty,
    tag: item.tag,
    samples: item.samples as number,
    passes: item.passes as number,
    scoreTotal: item.scoreTotal as number,
    durationMsTotal: item.durationMsTotal as number,
    retries: item.retries as number,
    toolFailures: item.toolFailures as number,
    updatedAt: item.updatedAt as number,
  }
}

export function parseAutoPerformanceProfile(value: unknown): AutoPerformanceProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Profil performa harus berupa object.')
  const input = value as Record<string, unknown>
  if (input.schemaVersion !== AUTO_PERFORMANCE_SCHEMA_VERSION) throw new Error(`Versi profil performa tidak didukung: ${String(input.schemaVersion)}.`)
  if (!finite(input.updatedAt) || !Array.isArray(input.stats) || input.stats.length > MAX_STATS) throw new Error('Profil performa tidak valid.')
  const stats = input.stats.map(parseStat)
  if (stats.some((item) => item === null)) throw new Error('Profil performa memuat statistik tidak valid.')
  return { schemaVersion: AUTO_PERFORMANCE_SCHEMA_VERSION, updatedAt: input.updatedAt, stats: stats as AutoPerformanceStat[] }
}

export function autoPerformanceFile(home: string): string {
  return join(home, AUTO_PERFORMANCE_PATH)
}

/** Profil rusak, terlalu besar, symlink, atau tidak ada diabaikan agar Auto tetap bekerja. */
export function loadAutoPerformanceProfile(home: string): AutoPerformanceProfile | null {
  const path = autoPerformanceFile(home)
  try {
    if (lstatSync(path).isSymbolicLink() || statSync(path).size > MAX_PROFILE_BYTES) return null
    return parseAutoPerformanceProfile(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return null
  }
}

export function saveAutoPerformanceProfile(home: string, profile: AutoPerformanceProfile): string {
  const path = autoPerformanceFile(home)
  const directory = join(home, '.boo')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  chmodSync(directory, 0o700)
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, path)
  chmodSync(path, 0o600)
  return path
}

function statKey(model: string, effort: string | undefined, difficulty: TaskDifficulty, tag: string): string {
  return `${model}\u0000${effort ?? ''}\u0000${difficulty}\u0000${tag}`
}

function reduceOldSamples(stat: AutoPerformanceStat): void {
  if (stat.samples < MAX_SAMPLES_PER_STAT) return
  stat.samples = Math.max(1, Math.round(stat.samples / 2))
  stat.passes = Math.round(stat.passes / 2)
  stat.scoreTotal /= 2
  stat.durationMsTotal /= 2
  stat.retries /= 2
  stat.toolFailures /= 2
}

/** Menggabungkan laporan benchmark; tidak ada prompt, jawaban, atau isi file yang disimpan. */
export function updateAutoPerformanceProfile(previous: AutoPerformanceProfile | null, report: EvalRunReport, now = Date.now()): AutoPerformanceProfile {
  const profile: AutoPerformanceProfile = previous
    ? { ...previous, stats: previous.stats.map((item) => ({ ...item })) }
    : { schemaVersion: AUTO_PERFORMANCE_SCHEMA_VERSION, updatedAt: now, stats: [] }
  const byKey = new Map(profile.stats.map((item) => [statKey(item.model, item.reasoningEffort, item.difficulty, item.tag), item]))
  for (const item of report.cases) {
    const metrics = item.metrics
    if (!metrics?.model || !metrics.difficulty || !DIFFICULTIES.has(metrics.difficulty as TaskDifficulty)) continue
    const difficulty = metrics.difficulty as TaskDifficulty
    const tags = ['*', ...new Set(item.tags.filter((tag) => /^[a-z0-9][a-z0-9_-]*$/i.test(tag)))]
    for (const tag of tags) {
      const key = statKey(metrics.model, metrics.reasoningEffort, difficulty, tag)
      const stat = byKey.get(key) ?? {
        model: metrics.model,
        ...(metrics.reasoningEffort ? { reasoningEffort: metrics.reasoningEffort } : {}),
        difficulty,
        tag,
        samples: 0,
        passes: 0,
        scoreTotal: 0,
        durationMsTotal: 0,
        retries: 0,
        toolFailures: 0,
        updatedAt: now,
      }
      reduceOldSamples(stat)
      stat.samples += 1
      stat.passes += item.passed ? 1 : 0
      stat.scoreTotal += item.score
      stat.durationMsTotal += item.durationMs
      stat.retries += metrics.retries
      stat.toolFailures += metrics.toolFailures
      stat.updatedAt = now
      byKey.set(key, stat)
    }
  }
  profile.updatedAt = now
  profile.stats = [...byKey.values()].sort((a, b) => statKey(a.model, a.reasoningEffort, a.difficulty, a.tag).localeCompare(statKey(b.model, b.reasoningEffort, b.difficulty, b.tag)))
  return profile
}

function quality(stats: readonly AutoPerformanceStat[]): { value: number; samples: number; duration: number } {
  const samples = stats.reduce((sum, item) => sum + item.samples, 0)
  if (!samples) return { value: 0, samples: 0, duration: Number.POSITIVE_INFINITY }
  const passes = stats.reduce((sum, item) => sum + item.passes, 0)
  const scores = stats.reduce((sum, item) => sum + item.scoreTotal, 0)
  const retries = stats.reduce((sum, item) => sum + item.retries, 0)
  const failures = stats.reduce((sum, item) => sum + item.toolFailures, 0)
  const duration = stats.reduce((sum, item) => sum + item.durationMsTotal, 0) / samples
  const value = (passes / samples) * 55 + (scores / samples) * 0.45
    - Math.min(8, (retries / samples) * 2) - Math.min(8, (failures / samples) * 1.5)
  return { value, samples, duration }
}

/** Hanya memakai profil bila minimal dua kandidat memiliki sampel yang cukup dan masih segar. */
export function selectByPerformance(
  options: readonly EffortOption[],
  difficulty: TaskDifficulty,
  tags: readonly string[],
  profile: AutoPerformanceProfile | null,
  now = Date.now(),
): PerformanceSelection | null {
  if (!profile) return null
  const fresh = profile.stats.filter((item) => item.difficulty === difficulty && now - item.updatedAt <= AUTO_PERFORMANCE_MAX_AGE_MS)
  const candidates = options.flatMap((option) => {
    const exact = fresh.filter((item) => item.model === option.modelId && (item.reasoningEffort ?? '') === (option.reasoningEffort ?? ''))
    const overall = exact.filter((item) => item.tag === '*')
    const overallQuality = quality(overall)
    if (overallQuality.samples < AUTO_PERFORMANCE_MIN_SAMPLES) return []
    const matched = exact.filter((item) => item.tag !== '*' && tags.includes(item.tag))
    const category = matched.length ? quality(matched) : null
    const value = category && category.samples >= 2 ? overallQuality.value * 0.7 + category.value * 0.3 : overallQuality.value
    return [{ option, quality: value, samples: overallQuality.samples, duration: overallQuality.duration }]
  })
  if (candidates.length < 2) return null
  candidates.sort((a, b) => b.quality - a.quality || b.samples - a.samples || a.duration - b.duration)
  const best = candidates[0]
  return { option: best.option, samples: best.samples, quality: Math.round(best.quality * 10) / 10 }
}

/** Tag kasar dari task; hanya untuk mencocokkan kategori eval, bukan menentukan kesulitan. */
export function inferPerformanceTags(input: string): string[] {
  const patterns: Array<[string, RegExp]> = [
    ['debugging', /bug|error|gagal|fail|rusak|perbaiki|fix|debug/i],
    ['implementation', /buat|implement|tambahkan|fitur|build|create|add/i],
    ['multi-file', /multi[- ]file|lintas (?:file|modul|paket)|cross[- ]module/i],
    ['investigation', /cari penyebab|telusur|investig|analisis|diagnos|jelaskan repository/i],
    ['security', /security|keamanan|secret|credential|auth|kerentanan/i],
    ['api', /\bapi\b|endpoint|public interface|kompatibilitas/i],
    ['testing', /\btest|pengujian|coverage|regresi|regression/i],
    ['documentation', /dokumentasi|readme|docs?\b/i],
  ]
  return patterns.filter(([, pattern]) => pattern.test(input)).map(([tag]) => tag)
}
