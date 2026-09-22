import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Agent } from '../src/agent/loop.ts'
import { formatTaskStatus, taskObjective, TaskStateTracker } from '../src/agent/taskState.ts'
import type { Message } from '../src/domain/message.ts'
import type { NineRouterProvider } from '../src/provider/nineRouter.ts'
import { createDefaultRegistry } from '../src/tools/index.ts'

test('task objective memakai permintaan asli dan melewati feedback otomatis', () => {
  assert.equal(taskObjective([
    { role: 'user', content: '[Boo workspace references]\n"Perbaiki @src/app.ts"\n\nsource' },
    { role: 'user', content: '[AUTOMATIC CRITIC FEEDBACK]\nperiksa lagi' },
  ]), 'Perbaiki @src/app.ts')
  assert.equal(taskObjective([
    { role: 'user', content: 'tujuan awal' },
    { role: 'user', content: '[USER STEERING]\ntambahkan dukungan Windows' },
  ]), 'tambahkan dukungan Windows')
})

test('tracker merangkum progres, tool, todo, file, keamanan, review, dan verifikasi', () => {
  const tracker = new TaskStateTracker([], 'model-awal')
  tracker.begin('implementasikan fitur', 'model-awal', undefined, 1_000)
  tracker.record({ type: 'model-selected', model: 'cx/gpt-5.6-sol', reasoningEffort: 'high', difficulty: 'complex', reason: 'berat', source: 'local' })
  tracker.record({ type: 'turn-start', turn: 0 })
  tracker.record({ type: 'tool-start', name: 'todo_write', callId: 'todo', preview: '', args: { todos: [
    { content: 'Implementasi', status: 'completed' },
    { content: 'Verifikasi', status: 'in_progress' },
  ] } })
  tracker.record({ type: 'tool-end', name: 'todo_write', callId: 'todo', content: 'ok', isError: false, cancelled: false })
  tracker.record({ type: 'tool-cache-hit', name: 'read_file', callId: 'cached', ref: 'abcdef0123456789', savedCharacters: 1_234 })
  tracker.record({ type: 'tool-start', name: 'write_file', callId: 'write', preview: '', args: {} })
  tracker.record({ type: 'tool-end', name: 'write_file', callId: 'write', content: 'ok', isError: false, cancelled: false })
  tracker.record({ type: 'tool-invalid', name: 'write_file', callId: 'invalid', kind: 'schema', issues: ['$.content: wajib diisi'] })
  tracker.record({ type: 'verification-state', status: 'needed', revision: 1 })
  tracker.record({ type: 'verification-needed', files: ['src/app.ts'] })
  tracker.record({ type: 'tool-start', name: 'bash', callId: 'test', preview: '', args: { command: 'pnpm test' } })
  tracker.record({ type: 'tool-end', name: 'bash', callId: 'test', content: 'ok', isError: false, cancelled: false })
  tracker.record({ type: 'verification-state', status: 'complete', revision: 1 })
  tracker.record({ type: 'prompt-injection-detected', tool: 'web_fetch', source: 'web', categories: ['instruction-override'] })
  tracker.record({ type: 'critic-start', round: 1 })
  tracker.record({ type: 'critic-end', round: 1, model: 'critic', status: 'findings', findings: 2 })
  tracker.record({ type: 'tool-protocol', stage: 'warning', model: 'model-awal', consecutiveTurns: 2, failures: 2, kinds: ['invalid-json'] })
  tracker.record({ type: 'tool-protocol', stage: 'fallback', model: 'model-awal', consecutiveTurns: 3, failures: 3, kinds: ['invalid-json'] })
  tracker.record({ type: 'context-trimmed', droppedMessages: 4, estimatedTokens: 900, prioritizedMessages: 2 })
  tracker.record({ type: 'tool-parallel', stage: 'started', name: 'discovery', tools: ['read_file', 'grep'], calls: 3 })
  tracker.record({ type: 'tool-parallel', stage: 'completed', name: 'discovery', tools: ['read_file', 'grep'], calls: 3, durationMs: 20 })
  tracker.record({ type: 'tool-result-truncated', name: 'git_diff', callId: 'large', ref: 'abcdef0123456789', originalCharacters: 100_000, visibleCharacters: 56_000 })
  tracker.finish(true, 2_500)

  const state = tracker.snapshot(2_500)
  assert.equal(state.outcome, 'completed')
  assert.equal(state.model, 'cx/gpt-5.6-sol')
  assert.equal(state.reasoningEffort, 'high')
  assert.equal(state.elapsedMs, 1_500)
  assert.equal(state.tools.started, 3)
  assert.equal(state.tools.completed, 3)
  assert.equal(state.tools.invalid, 1)
  assert.equal(state.verification, 'complete')
  assert.deepEqual(state.affectedFiles, ['src/app.ts'])
  assert.equal(state.ranCommands, true)
  assert.equal(state.promptInjectionDetected, true)
  assert.equal(state.criticFindings, 2)
  assert.equal(state.protocolWarnings, 1)
  assert.equal(state.protocolFallbacks, 1)
  assert.equal(state.evidenceCacheHits, 1)
  assert.equal(state.evidenceCacheSavedCharacters, 1_234)
  assert.equal(state.contextPrioritizedMessages, 2)
  assert.equal(state.parallelDiscoveryBatches, 1)
  assert.equal(state.parallelDiscoveryCalls, 3)
  assert.equal(state.truncatedToolResults, 1)
  assert.equal(state.deferredToolResultCharacters, 44_000)
  assert.match(formatTaskStatus(state), /1 argumen invalid.*Todo: 1\/2 selesai.*Verifikasi.*File terdampak.*src\/app\.ts.*Tool protocol: 1 peringatan · 1 fallback model.*Evidence cache: 1 hit.*Context relevance: 2 pesan.*Parallel discovery: 3 tool call.*Tool result store: 1 hasil besar.*prompt injection/s)
})

test('Agent memperbarui status task tanpa menambahkan metadata ke history', async () => {
  const seen: Message[][] = []
  const provider = {
    model: 'model-manual',
    reasoningEffort: 'medium',
    stream(messages: Message[]) {
      seen.push(messages)
      return (async function* reply() {
        yield { type: 'text' as const, delta: 'Selesai.' }
        return { finishReason: 'stop', message: { role: 'assistant' as const, content: 'Selesai.' } }
      })()
    },
  } as unknown as NineRouterProvider
  const agent = new Agent({
    provider, registry: createDefaultRegistry(),
    workspace: mkdtempSync(join(tmpdir(), 'boo-task-state-')),
    askPermission: async () => true,
  })
  for await (const event of agent.send('jelaskan proyek')) void event

  const state = await agent.taskStatus()
  assert.equal(state.objective, 'jelaskan proyek')
  assert.equal(state.outcome, 'completed')
  assert.equal(state.model, 'model-manual')
  assert.equal(state.reasoningEffort, 'medium')
  assert.equal(state.verification, 'not-required')
  assert.equal(agent.history.some((message) => message.content?.includes('Task ·')), false)
  assert.equal(seen.length, 1)
})

test('tracker mempertahankan tool yang belum pasti bila iterator dihentikan', () => {
  const tracker = new TaskStateTracker()
  tracker.begin('task terputus', 'model', undefined, 10)
  tracker.record({ type: 'tool-start', name: 'bash', callId: 'running', preview: '', args: { command: 'build' } })
  tracker.finish(false, 20, 'stopped')
  const state = tracker.snapshot(20)
  assert.equal(state.outcome, 'stopped')
  assert.deepEqual(state.activeTools, ['bash'])
})
