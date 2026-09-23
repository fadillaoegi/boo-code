/** Definisi suite, laporan, dan baseline untuk benchmark agent yang dapat direproduksi. */

import { statSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import type { EvalExpectation, EvalMetrics } from './harness.ts'
import type { TaskDifficulty } from '../provider/auto.ts'

export const EVAL_SCHEMA_VERSION = 1

export interface EvalCaseDefinition {
  id: string
  prompt: string
  fixture: string
  tags: string[]
  difficulty?: TaskDifficulty
  allowedCommands: string[]
  expect: EvalExpectation
}

export interface EvalSuiteDefinition {
  schemaVersion: 1
  name: string
  description?: string
  model?: string
  effort?: string
  coverage?: EvalCoverageRequirement
  cases: EvalCaseDefinition[]
}

export interface EvalCoverageRequirement {
  minCases?: number
  requiredTags?: string[]
  requiredDifficulties?: TaskDifficulty[]
}

export interface EvalCaseReport {
  id: string
  tags: string[]
  score: number
  passed: boolean
  durationMs: number
  metrics?: EvalMetrics
  error?: string
  workspace?: string
}

export interface EvalRunReport {
  schemaVersion: 1
  suite: string
  model: string
  effort?: string
  startedAt: string
  durationMs: number
  total: number
  passed: number
  failed: number
  passRate: number
  averageScore: number
  cases: EvalCaseReport[]
}

export interface EvalBaselineCase {
  score: number
  passed: boolean
}

export interface EvalBaseline {
  schemaVersion: 1
  suite: string
  createdAt: string
  cases: Record<string, EvalBaselineCase>
}

export interface EvalRegression {
  id: string
  baselineScore: number
  currentScore: number
  reason: string
}

export interface EvalBaselineComparison {
  passed: boolean
  regressions: EvalRegression[]
  improvements: string[]
  newCases: string[]
}

function record(value: unknown, location: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${location} harus berupa object.`)
  return value as Record<string, unknown>
}

function knownKeys(value: Record<string, unknown>, allowed: readonly string[], location: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unknown.length) throw new Error(`${location} memiliki field tidak dikenal: ${unknown.join(', ')}.`)
}

function text(value: unknown, location: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${location} harus berupa string yang tidak kosong.`)
  return value
}

function optionalText(value: unknown, location: string): string | undefined {
  return value === undefined ? undefined : text(value, location)
}

function stringArray(value: unknown, location: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`${location} harus berupa array string yang tidak kosong.`)
  }
  return [...new Set(value)]
}

function workspacePath(value: unknown, location: string): string {
  const path = text(value, location)
  if (isAbsolute(path) || /^[a-z]:[\\/]/i.test(path) || path.includes('\\')) {
    throw new Error(`${location} harus berupa path relatif dengan separator /.`)
  }
  if (path.split('/').some((part) => part === '.' || part === '..' || !part)) {
    throw new Error(`${location} tidak boleh keluar dari workspace atau memiliki segmen kosong.`)
  }
  return path
}

function workspacePathArray(value: unknown, location: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${location} harus berupa array path relatif.`)
  return [...new Set(value.map((item, index) => workspacePath(item, `${location}[${index}]`)))]
}

function positiveInteger(value: unknown, location: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || (value as number) < 1) throw new Error(`${location} harus berupa integer positif.`)
  return value as number
}

function nonNegativeInteger(value: unknown, location: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || (value as number) < 0) throw new Error(`${location} harus berupa integer nol atau positif.`)
  return value as number
}

function parseFileExpectation(value: unknown, location: string): NonNullable<EvalExpectation['files']>[number] {
  const item = record(value, location)
  knownKeys(item, ['path', 'exists', 'contains', 'notContains', 'sha256'], location)
  const path = workspacePath(item.path, `${location}.path`)
  if (item.exists !== undefined && typeof item.exists !== 'boolean') throw new Error(`${location}.exists harus boolean.`)
  if (item.contains !== undefined && typeof item.contains !== 'string') throw new Error(`${location}.contains harus string.`)
  if (item.notContains !== undefined && typeof item.notContains !== 'string') throw new Error(`${location}.notContains harus string.`)
  if (item.sha256 !== undefined && (typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(item.sha256))) throw new Error(`${location}.sha256 harus berupa hash SHA-256.`)
  return {
    path,
    ...(item.exists !== undefined ? { exists: item.exists } : {}),
    ...(item.contains !== undefined ? { contains: item.contains as string } : {}),
    ...(item.notContains !== undefined ? { notContains: item.notContains as string } : {}),
    ...(item.sha256 !== undefined ? { sha256: (item.sha256 as string).toLowerCase() } : {}),
  }
}

function parseExpectation(value: unknown, location: string): EvalExpectation {
  const input = record(value, location)
  knownKeys(input, [
    'files', 'requiredTools', 'forbiddenTools', 'requireVerification', 'maxTurns', 'maxToolCalls',
    'answerContains', 'answerNotContains', 'requiredChangedFiles', 'allowedChangedFiles',
    'forbiddenChangedFiles', 'maxChangedFiles',
  ], location)
  const files = input.files === undefined
    ? undefined
    : Array.isArray(input.files)
      ? input.files.map((item, index) => parseFileExpectation(item, `${location}.files[${index}]`))
      : (() => { throw new Error(`${location}.files harus berupa array.`) })()
  const requiredTools = input.requiredTools === undefined ? undefined : stringArray(input.requiredTools, `${location}.requiredTools`)
  const forbiddenTools = input.forbiddenTools === undefined ? undefined : stringArray(input.forbiddenTools, `${location}.forbiddenTools`)
  if (input.requireVerification !== undefined && typeof input.requireVerification !== 'boolean') throw new Error(`${location}.requireVerification harus boolean.`)
  if (input.answerContains !== undefined && typeof input.answerContains !== 'string') throw new Error(`${location}.answerContains harus string.`)
  if (input.answerNotContains !== undefined && typeof input.answerNotContains !== 'string') throw new Error(`${location}.answerNotContains harus string.`)
  const requiredChangedFiles = input.requiredChangedFiles === undefined ? undefined : workspacePathArray(input.requiredChangedFiles, `${location}.requiredChangedFiles`)
  const allowedChangedFiles = input.allowedChangedFiles === undefined ? undefined : workspacePathArray(input.allowedChangedFiles, `${location}.allowedChangedFiles`)
  const forbiddenChangedFiles = input.forbiddenChangedFiles === undefined ? undefined : workspacePathArray(input.forbiddenChangedFiles, `${location}.forbiddenChangedFiles`)
  const expectation: EvalExpectation = {
    ...(files ? { files } : {}),
    ...(requiredTools ? { requiredTools } : {}),
    ...(forbiddenTools ? { forbiddenTools } : {}),
    ...(input.requireVerification !== undefined ? { requireVerification: input.requireVerification } : {}),
    ...(positiveInteger(input.maxTurns, `${location}.maxTurns`) !== undefined ? { maxTurns: input.maxTurns as number } : {}),
    ...(positiveInteger(input.maxToolCalls, `${location}.maxToolCalls`) !== undefined ? { maxToolCalls: input.maxToolCalls as number } : {}),
    ...(input.answerContains !== undefined ? { answerContains: input.answerContains } : {}),
    ...(input.answerNotContains !== undefined ? { answerNotContains: input.answerNotContains } : {}),
    ...(requiredChangedFiles ? { requiredChangedFiles } : {}),
    ...(allowedChangedFiles ? { allowedChangedFiles } : {}),
    ...(forbiddenChangedFiles ? { forbiddenChangedFiles } : {}),
    ...(nonNegativeInteger(input.maxChangedFiles, `${location}.maxChangedFiles`) !== undefined ? { maxChangedFiles: input.maxChangedFiles as number } : {}),
  }
  if (!(files?.length || requiredTools?.length || forbiddenTools?.length || input.requireVerification !== undefined
    || input.maxTurns !== undefined || input.maxToolCalls !== undefined || input.answerContains !== undefined
    || input.answerNotContains !== undefined || input.requiredChangedFiles !== undefined || input.allowedChangedFiles !== undefined
    || input.forbiddenChangedFiles !== undefined || input.maxChangedFiles !== undefined)) {
    throw new Error(`${location} harus memiliki minimal satu pemeriksaan.`)
  }
  return expectation
}

/** Memvalidasi JSON suite dengan pesan yang menunjuk tepat ke field yang rusak. */
export function parseEvalSuite(value: unknown): EvalSuiteDefinition {
  const input = record(value, 'Suite')
  knownKeys(input, ['schemaVersion', 'name', 'description', 'model', 'effort', 'coverage', 'cases'], 'Suite')
  if (input.schemaVersion !== undefined && input.schemaVersion !== EVAL_SCHEMA_VERSION) {
    throw new Error(`schemaVersion suite tidak didukung: ${String(input.schemaVersion)}.`)
  }
  if (!Array.isArray(input.cases) || !input.cases.length) throw new Error('Suite.cases harus berupa array yang tidak kosong.')
  const ids = new Set<string>()
  const cases = input.cases.map((value, index): EvalCaseDefinition => {
    const location = `Suite.cases[${index}]`
    const item = record(value, location)
    knownKeys(item, ['id', 'prompt', 'fixture', 'tags', 'difficulty', 'allowedCommands', 'expect'], location)
    const id = text(item.id, `${location}.id`)
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id)) throw new Error(`${location}.id hanya boleh berisi huruf, angka, _ dan -.`)
    if (ids.has(id)) throw new Error(`ID kasus duplikat: ${id}.`)
    ids.add(id)
    const tags = stringArray(item.tags, `${location}.tags`)
    if (tags.some((tag) => !/^[a-z0-9][a-z0-9_-]*$/i.test(tag))) throw new Error(`${location}.tags berisi tag yang tidak valid.`)
    if (item.difficulty !== undefined && !['simple', 'standard', 'complex', 'expert'].includes(item.difficulty as string)) throw new Error(`${location}.difficulty tidak valid.`)
    return {
      id,
      prompt: text(item.prompt, `${location}.prompt`),
      fixture: text(item.fixture, `${location}.fixture`),
      tags,
      ...(item.difficulty ? { difficulty: item.difficulty as TaskDifficulty } : {}),
      allowedCommands: stringArray(item.allowedCommands, `${location}.allowedCommands`),
      expect: parseExpectation(item.expect, `${location}.expect`),
    }
  })
  let coverage: EvalCoverageRequirement | undefined
  if (input.coverage !== undefined) {
    const value = record(input.coverage, 'Suite.coverage')
    knownKeys(value, ['minCases', 'requiredTags', 'requiredDifficulties'], 'Suite.coverage')
    const requiredDifficulties = value.requiredDifficulties === undefined
      ? undefined
      : stringArray(value.requiredDifficulties, 'Suite.coverage.requiredDifficulties')
    if (requiredDifficulties?.some((difficulty) => !['simple', 'standard', 'complex', 'expert'].includes(difficulty))) {
      throw new Error('Suite.coverage.requiredDifficulties berisi difficulty yang tidak valid.')
    }
    coverage = {
      ...(positiveInteger(value.minCases, 'Suite.coverage.minCases') !== undefined ? { minCases: value.minCases as number } : {}),
      ...(value.requiredTags !== undefined ? { requiredTags: stringArray(value.requiredTags, 'Suite.coverage.requiredTags') } : {}),
      ...(requiredDifficulties ? { requiredDifficulties: requiredDifficulties as TaskDifficulty[] } : {}),
    }
  }
  return {
    schemaVersion: EVAL_SCHEMA_VERSION,
    name: text(input.name, 'Suite.name'),
    ...(optionalText(input.description, 'Suite.description') ? { description: input.description as string } : {}),
    ...(optionalText(input.model, 'Suite.model') ? { model: input.model as string } : {}),
    ...(optionalText(input.effort, 'Suite.effort') ? { effort: input.effort as string } : {}),
    ...(coverage ? { coverage } : {}),
    cases,
  }
}

/** Memastikan suite tidak tampak lengkap hanya karena banyak variasi dari satu jenis tugas. */
export function validateEvalCoverage(suite: EvalSuiteDefinition): string[] {
  if (!suite.coverage) return []
  const issues: string[] = []
  if (suite.coverage.minCases !== undefined && suite.cases.length < suite.coverage.minCases) {
    issues.push(`jumlah kasus ${suite.cases.length}, minimum ${suite.coverage.minCases}`)
  }
  const tags = new Set(suite.cases.flatMap((item) => item.tags))
  const missingTags = (suite.coverage.requiredTags ?? []).filter((tag) => !tags.has(tag))
  if (missingTags.length) issues.push(`tag wajib belum tercakup: ${missingTags.join(', ')}`)
  const difficulties = new Set(suite.cases.map((item) => item.difficulty).filter(Boolean))
  const missingDifficulties = (suite.coverage.requiredDifficulties ?? []).filter((difficulty) => !difficulties.has(difficulty))
  if (missingDifficulties.length) issues.push(`difficulty wajib belum tercakup: ${missingDifficulties.join(', ')}`)
  return issues
}

export function resolveEvalFixture(suitePath: string, fixture: string): string {
  return isAbsolute(fixture) ? resolve(fixture) : resolve(dirname(suitePath), fixture)
}

/** Pemeriksaan fixture terpisah agar `--validate` tidak membutuhkan provider/API key. */
export function validateEvalFixtures(suite: EvalSuiteDefinition, suitePath: string): string[] {
  const issues: string[] = []
  for (const item of suite.cases) {
    const fixture = resolveEvalFixture(suitePath, item.fixture)
    try {
      if (!statSync(fixture).isDirectory()) issues.push(`${item.id}: fixture bukan direktori (${fixture})`)
    } catch {
      issues.push(`${item.id}: fixture tidak ditemukan (${fixture})`)
    }
  }
  return issues
}

/** Filter bersifat AND: bila id dan tag diberikan, kasus harus memenuhi keduanya. */
export function selectEvalCases(suite: EvalSuiteDefinition, ids: readonly string[] = [], tags: readonly string[] = []): EvalCaseDefinition[] {
  const wantedIds = new Set(ids)
  const wantedTags = new Set(tags)
  return suite.cases.filter((item) =>
    (!wantedIds.size || wantedIds.has(item.id))
    && (!wantedTags.size || item.tags.some((tag) => wantedTags.has(tag))))
}

export function createEvalRunReport(options: {
  suite: string
  model: string
  effort?: string
  startedAt: Date
  durationMs: number
  cases: EvalCaseReport[]
}): EvalRunReport {
  const passed = options.cases.filter((item) => item.passed).length
  const score = options.cases.reduce((total, item) => total + item.score, 0)
  return {
    schemaVersion: EVAL_SCHEMA_VERSION,
    suite: options.suite,
    model: options.model,
    ...(options.effort ? { effort: options.effort } : {}),
    startedAt: options.startedAt.toISOString(),
    durationMs: Math.max(0, Math.round(options.durationMs)),
    total: options.cases.length,
    passed,
    failed: options.cases.length - passed,
    passRate: options.cases.length ? Math.round((passed / options.cases.length) * 100) : 0,
    averageScore: options.cases.length ? Math.round(score / options.cases.length) : 0,
    cases: options.cases,
  }
}

export function createEvalBaseline(report: EvalRunReport): EvalBaseline {
  return {
    schemaVersion: EVAL_SCHEMA_VERSION,
    suite: report.suite,
    createdAt: new Date().toISOString(),
    cases: Object.fromEntries(report.cases.map((item) => [item.id, { score: item.score, passed: item.passed }])),
  }
}

export function parseEvalBaseline(value: unknown): EvalBaseline {
  const input = record(value, 'Baseline')
  if (input.schemaVersion !== EVAL_SCHEMA_VERSION) throw new Error(`schemaVersion baseline tidak didukung: ${String(input.schemaVersion)}.`)
  const casesInput = record(input.cases, 'Baseline.cases')
  const cases: Record<string, EvalBaselineCase> = {}
  for (const [id, raw] of Object.entries(casesInput)) {
    const item = record(raw, `Baseline.cases.${id}`)
    if (typeof item.score !== 'number' || item.score < 0 || item.score > 100 || !Number.isFinite(item.score)) throw new Error(`Baseline.cases.${id}.score harus 0-100.`)
    if (typeof item.passed !== 'boolean') throw new Error(`Baseline.cases.${id}.passed harus boolean.`)
    cases[id] = { score: item.score, passed: item.passed }
  }
  return {
    schemaVersion: EVAL_SCHEMA_VERSION,
    suite: text(input.suite, 'Baseline.suite'),
    createdAt: text(input.createdAt, 'Baseline.createdAt'),
    cases,
  }
}

/** Membandingkan kasus yang dijalankan saja; filter parsial tidak menandai kasus lain hilang. */
export function compareEvalBaseline(report: EvalRunReport, baseline: EvalBaseline, tolerance = 0): EvalBaselineComparison {
  if (report.suite !== baseline.suite) throw new Error(`Baseline untuk suite "${baseline.suite}", bukan "${report.suite}".`)
  const regressions: EvalRegression[] = []
  const improvements: string[] = []
  const newCases: string[] = []
  const allowedDrop = Math.max(0, tolerance)
  for (const current of report.cases) {
    const previous = baseline.cases[current.id]
    if (!previous) {
      newCases.push(current.id)
      continue
    }
    if ((previous.passed && !current.passed) || current.score < previous.score - allowedDrop) {
      regressions.push({
        id: current.id,
        baselineScore: previous.score,
        currentScore: current.score,
        reason: previous.passed && !current.passed ? 'sebelumnya lulus, sekarang gagal' : `skor turun lebih dari toleransi ${allowedDrop}`,
      })
    } else if ((!previous.passed && current.passed) || current.score > previous.score) {
      improvements.push(current.id)
    }
  }
  return { passed: regressions.length === 0, regressions, improvements, newCases }
}
