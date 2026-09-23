import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent } from '../src/agent/loop.ts'
import { aggregateLocalTraces, LocalRunTrace, TRACE_DIRECTORY, traceAgentEvents, tracingEnabled } from '../src/eval/traces.ts'
import type { FailureCategory, FailurePostmortemReport } from '../src/agent/postmortem.ts'

function fixture() {
  return {
    home: mkdtempSync(join(tmpdir(), 'boo-trace-home-')),
    workspace: mkdtempSync(join(tmpdir(), 'boo-trace-workspace-')),
  }
}

function postmortem(category: FailureCategory): FailurePostmortemReport {
  return {
    schemaVersion: 1, id: 'report', workspaceId: 'workspace', startedAt: 1, finishedAt: 2, durationMs: 1,
    outcome: 'error', category, turns: 1, retries: 0, toolCalls: 0, toolFailures: 0, toolDenied: 0,
    toolInvalid: 0, toolTimeouts: 0, failedTools: [], timeoutTools: [], verificationRequested: false,
    verificationIncomplete: false, verificationRepairRounds: 0, verificationRepairExhausted: 0,
    protocolWarnings: 0, protocolFallbacks: 0, protocolStops: 0, protocolKinds: [], loopWarnings: 0,
    loopBlocks: 0, loopStops: 0, promptInjectionDetected: false,
  }
}

test('trace menyimpan metrik tetapi tidak menyimpan prompt, args, output, atau source code', () => {
  const { home, workspace } = fixture()
  let now = 1_000
  const trace = new LocalRunTrace({
    home, workspace, surface: 'cli', kind: 'send', mode: 'auto', model: 'fallback',
    requestCharacters: 42, now: () => now,
  })
  trace.record({ type: 'model-selected', model: 'smart-model', reasoningEffort: 'high', difficulty: 'complex', reason: 'rahasia prompt', source: 'model' })
  trace.record({ type: 'turn-start', turn: 0 })
  trace.record({ type: 'tool-start', name: 'read_file', callId: 'call-1', preview: 'baca secret.ts', args: { path: 'secret.ts', token: 'SANGAT_RAHASIA' } })
  trace.record({ type: 'tool-cache-hit', name: 'read_file', callId: 'call-1', ref: 'abcdef0123456789', savedCharacters: 1_234 })
  trace.record({ type: 'tool-recovery', name: 'bash', callId: 'timeout-1', kind: 'timeout', reason: 'idle', category: 'test', durationMs: 1_000, idleTimeoutMs: 1_000, maximumTimeoutMs: 5_000, nextIdleTimeoutMs: 2_000, partialOutput: true })
  trace.record({ type: 'verification-repair', stage: 'needed', round: 1, maxRounds: 3, revision: 1 })
  trace.record({ type: 'verification-repair', stage: 'repaired', round: 1, maxRounds: 3, revision: 1 })
  trace.record({ type: 'change-impact', changedFiles: 1, affectedFiles: 5, tests: 2, edges: 7, maxDepth: 3, blastRadius: 'medium', truncated: false })
  trace.record({ type: 'lsp-session', stage: 'started', openDocuments: 1 })
  trace.record({ type: 'lsp-session', stage: 'reused', openDocuments: 2 })
  now = 1_250
  trace.record({ type: 'tool-end', name: 'read_file', callId: 'call-1', content: 'SOURCE_CODE_RAHASIA', isError: false, cancelled: false })
  trace.record({ type: 'tool-invalid', name: 'write_file', callId: 'call-invalid', kind: 'schema', issues: ['RAHASIA_ISSUE'] })
  trace.record({ type: 'text', delta: 'JAWABAN_RAHASIA' })
  trace.record({ type: 'critic-start', round: 1 })
  trace.record({ type: 'critic-end', round: 1, model: 'critic-model', status: 'findings', findings: 2 })
  trace.record({ type: 'steering', messages: ['fokus ke test', 'jangan ubah API'] })
  trace.record({ type: 'risk-assessed', assessment: { level: 'high', score: 5, reasons: ['keamanan berubah'], changedFiles: 1, changedLines: 3 } })
  trace.record({ type: 'tool-protocol', stage: 'warning', model: 'smart-model', consecutiveTurns: 2, failures: 2, kinds: ['invalid-json'] })
  trace.record({ type: 'tool-protocol', stage: 'fallback', model: 'smart-model', consecutiveTurns: 3, failures: 3, kinds: ['invalid-json'] })
  trace.record({ type: 'context-trimmed', droppedMessages: 4, estimatedTokens: 900, prioritizedMessages: 2, dependencyMessages: 3, dependencyEdges: 2 })
  trace.record({ type: 'tool-parallel', stage: 'started', name: 'discovery', tools: ['read_file', 'grep'], calls: 3 })
  trace.record({ type: 'tool-parallel', stage: 'completed', name: 'discovery', tools: ['read_file', 'grep'], calls: 3, durationMs: 20 })
  trace.record({ type: 'tool-result-truncated', name: 'git_diff', callId: 'large', ref: 'abcdef0123456789', originalCharacters: 100_000, visibleCharacters: 56_000 })
  trace.record({ type: 'failure-postmortem', report: postmortem('tool-arguments') })
  now = 2_000
  const summary = trace.finish()

  assert.equal(summary?.durationMs, 1_000)
  assert.deepEqual(summary?.tools.read_file, { calls: 1, failures: 0, durationMs: 250 })
  assert.deepEqual(summary?.tools.write_file, { calls: 1, failures: 1, durationMs: 0 })
  assert.equal(summary?.toolCalls, 2)
  assert.equal(summary?.toolFailures, 1)
  assert.equal(summary?.criticReviews, 1)
  assert.equal(summary?.criticFindings, 2)
  assert.equal(summary?.criticFailures, 0)
  assert.equal(summary?.steeringMessages, 2)
  assert.equal(summary?.riskLevel, 'high')
  assert.equal(summary?.toolProtocolWarnings, 1)
  assert.equal(summary?.toolProtocolFallbacks, 1)
  assert.equal(summary?.toolProtocolStops, 0)
  assert.equal(summary?.evidenceCacheHits, 1)
  assert.equal(summary?.evidenceCacheSavedCharacters, 1_234)
  assert.equal(summary?.toolTimeoutRecoveries, 1)
  assert.equal(summary?.verificationRepairRounds, 1)
  assert.equal(summary?.verificationRepairs, 1)
  assert.equal(summary?.verificationRepairExhausted, 0)
  assert.equal(summary?.changeImpactAnalyses, 1)
  assert.equal(summary?.changeImpactAffectedFiles, 5)
  assert.equal(summary?.changeImpactEdges, 7)
  assert.equal(summary?.changeImpactLarge, 0)
  assert.equal(summary?.lspSessionStarts, 1)
  assert.equal(summary?.lspSessionReuses, 1)
  assert.equal(summary?.lspSessionRestarts, 0)
  assert.equal(summary?.contextPrioritizedMessages, 2)
  assert.equal(summary?.contextDependencyMessages, 3)
  assert.equal(summary?.contextDependencyEdges, 2)
  assert.equal(summary?.parallelDiscoveryBatches, 1)
  assert.equal(summary?.parallelDiscoveryCalls, 3)
  assert.equal(summary?.truncatedToolResults, 1)
  assert.equal(summary?.deferredToolResultCharacters, 44_000)
  assert.equal(summary?.failureCategory, 'tool-arguments')
  const directory = join(home, '.boo', TRACE_DIRECTORY)
  const path = join(directory, readdirSync(directory)[0])
  const raw = readFileSync(path, 'utf8')
  assert.doesNotMatch(raw, /SANGAT_RAHASIA|SOURCE_CODE_RAHASIA|JAWABAN_RAHASIA|RAHASIA_ISSUE|secret\.ts|rahasia prompt/)
  assert.equal(statSync(path).mode & 0o777, 0o600)
  assert.equal(statSync(directory).mode & 0o777, 0o700)
})

test('agregasi hanya membaca trace dari workspace yang diminta', () => {
  const { home, workspace } = fixture()
  const other = mkdtempSync(join(tmpdir(), 'boo-trace-other-'))
  for (const [target, outcome] of [[workspace, 'completed'], [workspace, 'error'], [other, 'completed']] as const) {
    const trace = new LocalRunTrace({ home, workspace: target, surface: 'web', kind: 'send', mode: 'manual', model: 'model-a', requestCharacters: 5 })
    trace.record({ type: 'turn-start', turn: 0 })
    trace.record({ type: 'tool-start', name: 'grep', callId: `${target}-${outcome}`, preview: 'cari', args: {} })
    if (outcome === 'completed') trace.record({ type: 'tool-cache-hit', name: 'grep', callId: `${target}-${outcome}`, ref: 'abcdef0123456789', savedCharacters: 500 })
    trace.record({ type: 'tool-end', name: 'grep', callId: `${target}-${outcome}`, content: '', isError: outcome === 'error', cancelled: false })
    trace.record({ type: 'critic-start', round: 1 })
    trace.record({ type: 'critic-end', round: 1, model: 'critic-model', status: outcome === 'error' ? 'error' : 'findings', findings: outcome === 'error' ? 0 : 1 })
    if (outcome === 'completed') trace.record({ type: 'steering', messages: ['lanjut'] })
    if (outcome === 'completed') trace.record({ type: 'risk-assessed', assessment: { level: 'high', score: 5, reasons: ['keamanan berubah'], changedFiles: 1, changedLines: 2 } })
    if (outcome === 'completed') trace.record({ type: 'context-trimmed', droppedMessages: 3, estimatedTokens: 500, prioritizedMessages: 1, dependencyMessages: 2, dependencyEdges: 3 })
    if (outcome === 'completed') trace.record({ type: 'tool-parallel', stage: 'started', name: 'discovery', tools: ['read_file'], calls: 2 })
    if (outcome === 'completed') trace.record({ type: 'tool-result-truncated', name: 'git_diff', callId: `${target}-large`, originalCharacters: 90_000, visibleCharacters: 56_000 })
    if (outcome === 'completed') trace.record({ type: 'verification-repair', stage: 'needed', round: 1, maxRounds: 3, revision: 1 })
    if (outcome === 'completed') trace.record({ type: 'verification-repair', stage: 'exhausted', round: 3, maxRounds: 3, revision: 1 })
    if (outcome === 'completed') trace.record({ type: 'change-impact', changedFiles: 2, affectedFiles: 30, tests: 4, edges: 40, maxDepth: 5, blastRadius: 'large', truncated: true })
    if (outcome === 'completed') trace.record({ type: 'lsp-session', stage: 'restarted', openDocuments: 1 })
    if (outcome === 'error') trace.record({ type: 'failure-postmortem', report: postmortem('provider-auth') })
    trace.finish(outcome)
  }
  const stats = aggregateLocalTraces(home, workspace)
  assert.equal(stats.runs, 2)
  assert.equal(stats.completed, 1)
  assert.equal(stats.errors, 1)
  assert.equal(stats.averageTurns, 1)
  assert.equal(stats.averageToolCalls, 1)
  assert.equal(stats.toolFailureRate, 50)
  assert.equal(stats.criticReviews, 2)
  assert.equal(stats.criticFindings, 1)
  assert.equal(stats.criticFailures, 1)
  assert.equal(stats.steeringMessages, 1)
  assert.equal(stats.highRiskRuns, 1)
  assert.equal(stats.evidenceCacheHits, 1)
  assert.equal(stats.evidenceCacheSavedCharacters, 500)
  assert.equal(stats.contextPrioritizedMessages, 1)
  assert.equal(stats.contextDependencyMessages, 2)
  assert.equal(stats.contextDependencyEdges, 3)
  assert.equal(stats.parallelDiscoveryBatches, 1)
  assert.equal(stats.parallelDiscoveryCalls, 2)
  assert.equal(stats.truncatedToolResults, 1)
  assert.equal(stats.deferredToolResultCharacters, 34_000)
  assert.equal(stats.verificationRepairRounds, 3)
  assert.equal(stats.verificationRepairs, 0)
  assert.equal(stats.verificationRepairExhausted, 1)
  assert.equal(stats.changeImpactAnalyses, 1)
  assert.equal(stats.changeImpactAffectedFiles, 30)
  assert.equal(stats.changeImpactEdges, 40)
  assert.equal(stats.changeImpactLarge, 1)
  assert.equal(stats.lspSessionStarts, 0)
  assert.equal(stats.lspSessionReuses, 0)
  assert.equal(stats.lspSessionRestarts, 1)
  assert.deepEqual(stats.failureCategories, { 'provider-auth': 1 })
  assert.deepEqual(stats.models, { 'model-a': 2 })
})

test('agregasi memigrasikan metrik parallel read dari trace lama', () => {
  const { home, workspace } = fixture()
  const trace = new LocalRunTrace({ home, workspace, surface: 'cli', kind: 'send', mode: 'manual', model: 'model-a', requestCharacters: 1 })
  trace.finish()
  const directory = join(home, '.boo', TRACE_DIRECTORY)
  const path = join(directory, readdirSync(directory)[0])
  const legacy = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  delete legacy.parallelDiscoveryBatches
  delete legacy.parallelDiscoveryCalls
  legacy.parallelReadBatches = 2
  legacy.parallelReadCalls = 6
  writeFileSync(path, `${JSON.stringify(legacy)}\n`)

  const stats = aggregateLocalTraces(home, workspace)
  assert.equal(stats.parallelDiscoveryBatches, 2)
  assert.equal(stats.parallelDiscoveryCalls, 6)
})

test('wrapper event memastikan trace ditutup dan konfigurasi false dikenali', async () => {
  const { home, workspace } = fixture()
  const trace = new LocalRunTrace({ home, workspace, surface: 'api', kind: 'send', mode: 'manual', model: 'm', requestCharacters: 1 })
  async function* events(): AsyncGenerator<AgentEvent> {
    yield { type: 'turn-start', turn: 0 }
    yield { type: 'cancelled' }
  }
  const seen: AgentEvent[] = []
  for await (const event of traceAgentEvents(events(), trace)) seen.push(event)
  assert.equal(seen.length, 2)
  assert.equal(aggregateLocalTraces(home, workspace).cancelled, 1)
  assert.equal(tracingEnabled(undefined), true)
  assert.equal(tracingEnabled('false'), false)
  assert.equal(tracingEnabled('0'), false)
})
