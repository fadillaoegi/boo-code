/** Penilaian objektif satu run agent terhadap ekspektasi yang dapat diperiksa. */

import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
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
}

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
}

export interface EvalResult {
  passed: boolean
  score: number
  checks: EvalCheck[]
  metrics: EvalMetrics
}

export function summarizeAgentRun(events: readonly AgentEvent[]): EvalMetrics {
  const tools: Record<string, number> = {}
  for (const event of events) {
    if (event.type === 'tool-start') tools[event.name] = (tools[event.name] ?? 0) + 1
  }
  const selected = [...events].reverse().find((event): event is Extract<AgentEvent, { type: 'model-selected' }> => event.type === 'model-selected')
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

export function evaluateAgentRun(workspace: string, events: readonly AgentEvent[], expectation: EvalExpectation): EvalResult {
  const metrics = summarizeAgentRun(events)
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

  const passedCount = checks.filter((check) => check.passed).length
  return {
    passed: checks.length > 0 && passedCount === checks.length,
    score: checks.length ? Math.round((passedCount / checks.length) * 100) : 0,
    checks,
    metrics,
  }
}
