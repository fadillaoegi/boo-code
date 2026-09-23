/** Penilaian objektif satu run agent terhadap ekspektasi yang dapat diperiksa. */

import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import type { AgentEvent } from '../agent/loop.ts'
import { resolveInWorkspace } from '../tools/workspace.ts'

export interface EvalFileExpectation {
  path: string
  exists?: boolean
  contains?: string
  notContains?: string
  /** Hash isi yang diharapkan; berguna untuk membuktikan test/fixture tidak diubah. */
  sha256?: string
}

export interface EvalExpectation {
  files?: EvalFileExpectation[]
  requiredTools?: string[]
  forbiddenTools?: string[]
  requireVerification?: boolean
  maxTurns?: number
  maxToolCalls?: number
  answerContains?: string
  answerNotContains?: string
  /** File yang wajib berubah dibanding snapshot fixture sebelum agent berjalan. */
  requiredChangedFiles?: string[]
  /** Bila diberikan, setiap perubahan di luar daftar ini menggagalkan kasus. */
  allowedChangedFiles?: string[]
  /** File yang sama sekali tidak boleh berubah, dihapus, atau dibuat. */
  forbiddenChangedFiles?: string[]
  maxChangedFiles?: number
}

export type EvalWorkspaceSnapshot = Record<string, string>

export interface EvalCheck {
  name: string
  passed: boolean
  detail: string
}

export interface EvalMetrics {
  turns: number
  toolCalls: number
  toolFailures: number
  retries: number
  tools: Record<string, number>
  model?: string
  reasoningEffort?: string
  difficulty?: string
  verificationRequested: boolean
  verificationIncomplete: boolean
  verificationRepairRounds: number
  verificationRepairs: number
  verificationRepairExhausted: number
  changeImpactAnalyses: number
  changeImpactAffectedFiles: number
  changeImpactEdges: number
  changeImpactLarge: number
  lspSessionStarts: number
  lspSessionReuses: number
  lspSessionRestarts: number
  contextDependencyMessages?: number
  contextDependencyEdges?: number
  changedFiles?: string[]
}

export interface EvalResult {
  passed: boolean
  score: number
  checks: EvalCheck[]
  metrics: EvalMetrics
}

/** Snapshot hash file reguler; symlink sengaja dilewati agar tidak membaca keluar workspace. */
export function createEvalWorkspaceSnapshot(workspace: string): EvalWorkspaceSnapshot {
  const root = resolve(workspace)
  const snapshot: EvalWorkspaceSnapshot = {}
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) {
        visit(path)
      } else if (entry.isFile() && !lstatSync(path).isSymbolicLink()) {
        const key = relative(root, path).split(sep).join('/')
        snapshot[key] = createHash('sha256').update(readFileSync(path)).digest('hex')
      }
    }
  }
  visit(root)
  return snapshot
}

export function changedEvalFiles(before: EvalWorkspaceSnapshot, after: EvalWorkspaceSnapshot): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((path) => before[path] !== after[path])
    .sort()
}

export function summarizeAgentRun(events: readonly AgentEvent[]): EvalMetrics {
  const tools: Record<string, number> = {}
  for (const event of events) {
    if (event.type === 'tool-start') tools[event.name] = (tools[event.name] ?? 0) + 1
  }
  const selected = [...events].reverse().find((event): event is Extract<AgentEvent, { type: 'model-selected' }> => event.type === 'model-selected')
  const repairs = events.filter((event): event is Extract<AgentEvent, { type: 'verification-repair' }> => event.type === 'verification-repair')
  const impacts = events.filter((event): event is Extract<AgentEvent, { type: 'change-impact' }> => event.type === 'change-impact')
  const contextTrims = events.filter((event): event is Extract<AgentEvent, { type: 'context-trimmed' }> => event.type === 'context-trimmed')
  return {
    turns: events.filter((event) => event.type === 'turn-start').length,
    toolCalls: events.filter((event) => event.type === 'tool-start').length,
    toolFailures: events.filter((event) => event.type === 'tool-end' && event.isError).length,
    retries: events.filter((event) => event.type === 'retry').length,
    tools,
    ...(selected ? {
      model: selected.model,
      ...(selected.reasoningEffort ? { reasoningEffort: selected.reasoningEffort } : {}),
      difficulty: selected.difficulty,
    } : {}),
    verificationRequested: events.some((event) => event.type === 'verification-needed'),
    verificationIncomplete: events.some((event) => event.type === 'verification-incomplete'),
    verificationRepairRounds: repairs.reduce((maximum, event) => Math.max(maximum, event.round), 0),
    verificationRepairs: repairs.filter((event) => event.stage === 'repaired').length,
    verificationRepairExhausted: repairs.filter((event) => event.stage === 'exhausted').length,
    changeImpactAnalyses: impacts.length,
    changeImpactAffectedFiles: impacts.reduce((sum, event) => sum + event.affectedFiles, 0),
    changeImpactEdges: impacts.reduce((sum, event) => sum + event.edges, 0),
    changeImpactLarge: impacts.filter((event) => event.blastRadius === 'large').length,
    lspSessionStarts: events.filter((event) => event.type === 'lsp-session' && event.stage === 'started').length,
    lspSessionReuses: events.filter((event) => event.type === 'lsp-session' && event.stage === 'reused').length,
    lspSessionRestarts: events.filter((event) => event.type === 'lsp-session' && event.stage === 'restarted').length,
    contextDependencyMessages: contextTrims.reduce((sum, event) => sum + (event.dependencyMessages ?? 0), 0),
    contextDependencyEdges: contextTrims.reduce((sum, event) => sum + (event.dependencyEdges ?? 0), 0),
  }
}

function checkFile(workspace: string, expected: EvalFileExpectation): EvalCheck[] {
  const checks: EvalCheck[] = []
  let exists: boolean
  let content = ''
  try {
    const path = resolveInWorkspace(workspace, expected.path)
    exists = statSync(path).isFile()
    if (exists) content = readFileSync(path, 'utf8')
  } catch {
    exists = false
  }

  const shouldExist = expected.exists ?? true
  checks.push({
    name: `file:${expected.path}:exists`,
    passed: exists === shouldExist,
    detail: exists === shouldExist ? `exists=${exists}` : `expected exists=${shouldExist}, received ${exists}`,
  })
  if (expected.contains !== undefined) {
    const passed = exists && content.includes(expected.contains)
    checks.push({ name: `file:${expected.path}:contains`, passed, detail: passed ? 'required text found' : 'required text not found' })
  }
  if (expected.notContains !== undefined) {
    const passed = !exists || !content.includes(expected.notContains)
    checks.push({ name: `file:${expected.path}:not-contains`, passed, detail: passed ? 'forbidden text absent' : 'forbidden text found' })
  }
  if (expected.sha256 !== undefined) {
    const received = exists ? createHash('sha256').update(content).digest('hex') : ''
    const passed = received === expected.sha256.toLowerCase()
    checks.push({ name: `file:${expected.path}:sha256`, passed, detail: passed ? 'hash matched' : `expected ${expected.sha256.toLowerCase()}, received ${received || '(missing)'}` })
  }
  return checks
}

export function evaluateAgentRun(
  workspace: string,
  events: readonly AgentEvent[],
  expectation: EvalExpectation,
  initialSnapshot?: EvalWorkspaceSnapshot,
): EvalResult {
  const changedFiles = initialSnapshot
    ? changedEvalFiles(initialSnapshot, createEvalWorkspaceSnapshot(workspace))
    : undefined
  const metrics: EvalMetrics = {
    ...summarizeAgentRun(events),
    ...(changedFiles ? { changedFiles } : {}),
  }
  const checks: EvalCheck[] = []
  for (const file of expectation.files ?? []) checks.push(...checkFile(workspace, file))
  for (const tool of expectation.requiredTools ?? []) {
    const passed = Boolean(metrics.tools[tool])
    checks.push({ name: `tool:${tool}:required`, passed, detail: passed ? `used ${metrics.tools[tool]} time(s)` : 'never used' })
  }
  for (const tool of expectation.forbiddenTools ?? []) {
    const passed = !metrics.tools[tool]
    checks.push({ name: `tool:${tool}:forbidden`, passed, detail: passed ? 'not used' : `used ${metrics.tools[tool]} time(s)` })
  }
  if (expectation.requireVerification !== undefined) {
    const passed = expectation.requireVerification
      ? metrics.verificationRequested && !metrics.verificationIncomplete
      : !metrics.verificationRequested
    checks.push({ name: 'verification', passed, detail: passed ? 'verification policy satisfied' : 'verification policy not satisfied' })
  }
  if (expectation.maxTurns !== undefined) {
    const passed = metrics.turns <= expectation.maxTurns
    checks.push({ name: 'max-turns', passed, detail: `${metrics.turns}/${expectation.maxTurns}` })
  }
  if (expectation.maxToolCalls !== undefined) {
    const passed = metrics.toolCalls <= expectation.maxToolCalls
    checks.push({ name: 'max-tool-calls', passed, detail: `${metrics.toolCalls}/${expectation.maxToolCalls}` })
  }
  if (expectation.answerContains !== undefined) {
    const answer = events.filter((event): event is Extract<AgentEvent, { type: 'text' }> => event.type === 'text').map((event) => event.delta).join('')
    const passed = answer.includes(expectation.answerContains)
    checks.push({ name: 'answer-contains', passed, detail: passed ? 'required text found' : 'required text not found' })
  }
  if (expectation.answerNotContains !== undefined) {
    const answer = events.filter((event): event is Extract<AgentEvent, { type: 'text' }> => event.type === 'text').map((event) => event.delta).join('')
    const passed = !answer.includes(expectation.answerNotContains)
    checks.push({ name: 'answer-not-contains', passed, detail: passed ? 'forbidden text absent' : 'forbidden text found' })
  }
  const snapshotRequired = expectation.requiredChangedFiles !== undefined
    || expectation.allowedChangedFiles !== undefined
    || expectation.forbiddenChangedFiles !== undefined
    || expectation.maxChangedFiles !== undefined
  if (snapshotRequired && !changedFiles) {
    checks.push({ name: 'changed-files:snapshot', passed: false, detail: 'snapshot awal workspace tidak diberikan' })
  } else if (changedFiles) {
    const changed = new Set(changedFiles)
    for (const path of expectation.requiredChangedFiles ?? []) {
      const passed = changed.has(path)
      checks.push({ name: `changed-file:${path}:required`, passed, detail: passed ? 'file changed' : 'file did not change' })
    }
    if (expectation.allowedChangedFiles !== undefined) {
      const allowed = new Set(expectation.allowedChangedFiles)
      const unexpected = changedFiles.filter((path) => !allowed.has(path))
      checks.push({
        name: 'changed-files:allowed',
        passed: unexpected.length === 0,
        detail: unexpected.length ? `perubahan tidak diizinkan: ${unexpected.join(', ')}` : 'all changed files allowed',
      })
    }
    for (const path of expectation.forbiddenChangedFiles ?? []) {
      const passed = !changed.has(path)
      checks.push({ name: `changed-file:${path}:forbidden`, passed, detail: passed ? 'file unchanged' : 'file changed' })
    }
    if (expectation.maxChangedFiles !== undefined) {
      const passed = changedFiles.length <= expectation.maxChangedFiles
      checks.push({ name: 'max-changed-files', passed, detail: `${changedFiles.length}/${expectation.maxChangedFiles}` })
    }
  }

  const passedCount = checks.filter((check) => check.passed).length
  return {
    passed: checks.length > 0 && passedCount === checks.length,
    score: checks.length ? Math.round((passedCount / checks.length) * 100) : 0,
    checks,
    metrics,
  }
}
