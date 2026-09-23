import assert from 'node:assert/strict'
import test from 'node:test'
import { lstatSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Agent, type AgentEvent } from '../src/agent/loop.ts'
import { createRegistry } from '../src/domain/tool.ts'
import {
  FailurePostmortemTracker,
  formatFailurePostmortem,
  loadLatestFailurePostmortem,
  parseFailurePostmortem,
  saveFailurePostmortem,
} from '../src/agent/postmortem.ts'
import { NineRouterProvider, ProviderError } from '../src/provider/nineRouter.ts'

function workspace(): string {
  return mkdtempSync(join(tmpdir(), 'boo-postmortem-workspace-'))
}

async function collect(events: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const output: AgentEvent[] = []
  for await (const event of events) output.push(event)
  return output
}

test('tracker hanya membuat postmortem untuk task yang benar-benar berhenti gagal', () => {
  const recovered = new FailurePostmortemTracker({ workspace: workspace(), model: 'model-a', now: () => 20 })
  recovered.record({ type: 'tool-start', name: 'bash', preview: 'run', callId: 'a', args: {} })
  recovered.record({ type: 'tool-end', name: 'bash', callId: 'a', content: 'SECRET output', isError: true, cancelled: false })
  recovered.record({ type: 'turn-end', message: { role: 'assistant', content: 'pulih' } })
  assert.equal(recovered.finish(), null)

  const cancelled = new FailurePostmortemTracker({ workspace: workspace() })
  cancelled.record({ type: 'error', message: 'temporary failure' })
  cancelled.record({ type: 'cancelled' })
  assert.equal(cancelled.finish(), null)
})

test('postmortem mengklasifikasikan provider tanpa menyimpan pesan error mentah', () => {
  let now = 100
  const tracker = new FailurePostmortemTracker({ workspace: workspace(), model: 'model-a', reasoningEffort: 'high', now: () => now })
  tracker.record({ type: 'turn-start', turn: 0 })
  tracker.record({ type: 'retry', attempt: 1, maxAttempts: 2, delayMs: 10, message: 'SECRET retry output' })
  tracker.record({ type: 'error', message: '401 Unauthorized api key SECRET-123' })
  now = 250
  const report = tracker.finish()
  assert.equal(report?.category, 'provider-auth')
  assert.equal(report?.outcome, 'error')
  assert.equal(report?.turns, 1)
  assert.equal(report?.retries, 1)
  assert.doesNotMatch(JSON.stringify(report), /SECRET|Unauthorized|api key/i)
  assert.match(formatFailurePostmortem(report), /boo-code doctor/)
})

test('bukti terminal spesifik menang atas error umum', () => {
  const verification = new FailurePostmortemTracker({ workspace: workspace() })
  verification.record({ type: 'error', message: 'unknown' })
  verification.record({ type: 'verification-repair', stage: 'exhausted', round: 3, maxRounds: 3, revision: 2 })
  verification.record({ type: 'verification-incomplete', files: ['secret/path.ts'], attempted: true })
  const report = verification.finish()
  assert.equal(report?.category, 'verification')
  assert.equal(report?.verificationRepairRounds, 3)
  assert.doesNotMatch(JSON.stringify(report), /secret\/path/)

  const protocol = new FailurePostmortemTracker({ workspace: workspace() })
  protocol.record({ type: 'tool-protocol', stage: 'stopped', model: 'm', consecutiveTurns: 3, failures: 3, kinds: ['invalid-json'] })
  assert.equal(protocol.finish()?.category, 'tool-protocol')

  const loop = new FailurePostmortemTracker({ workspace: workspace() })
  loop.record({ type: 'tool-loop', name: 'read_file', stage: 'stopped', repetitions: 5 })
  assert.equal(loop.finish()?.category, 'tool-loop')
})

test('postmortem privat, parser ketat, dan loader melewati file terbaru yang rusak', () => {
  const home = mkdtempSync(join(tmpdir(), 'boo-postmortem-home-'))
  const root = workspace()
  const tracker = new FailurePostmortemTracker({ workspace: root, model: 'model-a', home, now: () => 1_000 })
  tracker.record({
    type: 'tool-recovery', name: 'bash', callId: 'a', kind: 'timeout', reason: 'idle', category: 'test',
    durationMs: 5, idleTimeoutMs: 1_000, maximumTimeoutMs: 5_000, nextIdleTimeoutMs: 2_000, partialOutput: true,
  })
  tracker.record({ type: 'error', message: 'unknown failure with SECRET output' })
  const report = tracker.finish()
  assert.equal(report?.category, 'tool-timeout')
  const loaded = loadLatestFailurePostmortem(home, root)
  assert.deepEqual(loaded, report)

  const parent = join(home, '.boo', 'postmortems')
  const directory = join(parent, readdirSync(parent)[0])
  const stored = join(directory, readdirSync(directory).find((name) => name.endsWith('.json'))!)
  assert.equal(statSync(directory).mode & 0o777, 0o700)
  assert.equal(statSync(stored).mode & 0o777, 0o600)
  assert.equal(lstatSync(stored).isSymbolicLink(), false)
  assert.doesNotMatch(readFileSync(stored, 'utf8'), /SECRET|unknown failure|idle|partial/i)

  writeFileSync(join(directory, '9999999999999-corrupt.json'), '{broken', { mode: 0o600 })
  assert.deepEqual(loadLatestFailurePostmortem(home, root), report)
  assert.throws(() => parseFailurePostmortem({ ...report, category: 'invented' }), /tidak valid/)
  assert.throws(() => parseFailurePostmortem({ ...report, id: '../keluar' }), /tidak valid/)
})

test('save menghasilkan laporan yang dapat dibaca kembali', () => {
  const home = mkdtempSync(join(tmpdir(), 'boo-postmortem-save-'))
  const root = workspace()
  const tracker = new FailurePostmortemTracker({ workspace: root, now: () => 10 })
  tracker.record({ type: 'turn-limit', turns: 40 })
  const report = tracker.finish()!
  const path = saveFailurePostmortem(home, root, report)
  assert.ok(path.endsWith('.json'))
  assert.equal(loadLatestFailurePostmortem(home, root)?.category, 'turn-limit')
})

test('Agent menerbitkan dan menyimpan postmortem setelah error provider', async () => {
  const home = mkdtempSync(join(tmpdir(), 'boo-postmortem-agent-'))
  const root = workspace()
  const provider = new NineRouterProvider({ baseUrl: 'http://unused.invalid', apiKey: 'fake', model: 'model-a' })
  // eslint-disable-next-line require-yield
  provider.stream = async function* () {
    throw new ProviderError('429 quota exceeded SECRET-XYZ', { status: 429, retryable: false })
  }
  const agent = new Agent({ provider, registry: createRegistry([]), workspace: root, home, askPermission: async () => true })
  const events = await collect(agent.send('prompt rahasia tidak boleh tersimpan'))
  const postmortem = events.find((event): event is Extract<AgentEvent, { type: 'failure-postmortem' }> => event.type === 'failure-postmortem')
  assert.equal(postmortem?.report.category, 'provider-rate-limit')
  assert.ok(events.findIndex((event) => event.type === 'failure-postmortem') < events.findIndex((event) => event.type === 'error'))
  assert.equal(events.at(-1)?.type, 'error', 'event terminal tetap terakhir untuk kompatibilitas consumer')
  const persisted = loadLatestFailurePostmortem(home, root)
  assert.equal(persisted?.category, 'provider-rate-limit')
  assert.doesNotMatch(JSON.stringify(persisted), /rahasia|SECRET|quota exceeded/i)
})
