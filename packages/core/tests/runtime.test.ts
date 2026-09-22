import assert from 'node:assert/strict'
import test from 'node:test'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Agent } from '../src/agent/loop.ts'
import { CHECKPOINT_DIRECTORY, Checkpoints } from '../src/agent/checkpoints.ts'
import type { AgentEvent } from '../src/agent/loop.ts'
import type { Message } from '../src/domain/message.ts'
import type { NineRouterProvider } from '../src/provider/nineRouter.ts'
import {
  journalAgentEvents,
  latestInterruptedRun,
  PersistentRunJournal,
  recoveryTaskObjective,
  RUN_DIRECTORY,
  runRecoveryPrompt,
} from '../src/runtime/runs.ts'
import { createDefaultRegistry } from '../src/tools/index.ts'

function fixture() {
  return {
    home: mkdtempSync(join(tmpdir(), 'boo-runtime-home-')),
    workspace: mkdtempSync(join(tmpdir(), 'boo-runtime-workspace-')),
  }
}

test('jurnal run mendeteksi crash tanpa menyimpan prompt, args, source, atau output', () => {
  const { home, workspace } = fixture()
  let now = 1_000
  const journal = new PersistentRunJournal({ home, workspace, sessionId: 'session-a', surface: 'cli', kind: 'send', now: () => now, pid: 2_147_483_647 })
  journal.record({ type: 'turn-start', turn: 2 })
  journal.record({ type: 'model-selected', model: 'ag/gemini-3.1-pro', reasoningEffort: 'high', difficulty: 'complex', reason: 'test', source: 'local' })
  journal.record({ type: 'tool-start', name: 'read_file', callId: 'call-read', preview: 'secret.ts', args: { path: 'secret.ts' } })
  journal.record({ type: 'tool-end', name: 'read_file', callId: 'call-read', content: 'SOURCE_RAHASIA', isError: false, cancelled: false })
  journal.record({ type: 'tool-start', name: 'bash', callId: 'call-bash', preview: 'command', args: { command: 'rahasia' } })
  journal.record({ type: 'tool-end', name: 'bash', callId: 'call-bash', content: 'OUTPUT_RAHASIA', isError: true, cancelled: false })
  journal.record({ type: 'tool-denied', name: 'launch_app', callId: 'call-denied', feedback: 'RAHASIA_FEEDBACK' })
  journal.record({ type: 'tool-invalid', name: 'write_file', callId: 'call-invalid', kind: 'schema', issues: ['RAHASIA_ISSUE'] })
  journal.record({ type: 'tool-start', name: 'write_file', callId: 'call-a', preview: 'RAHASIA_PREVIEW', args: { path: 'secret.ts', content: 'SOURCE_RAHASIA' } })
  journal.record({ type: 'verification-state', status: 'needed', revision: 1 })
  journal.record({ type: 'prompt-injection-detected', tool: 'web_fetch', source: 'web', categories: ['instruction-override'] })
  journal.record({ type: 'text', delta: 'JAWABAN_RAHASIA' })
  now = 1_500

  const root = join(home, '.boo', RUN_DIRECTORY)
  const workspaceDirectory = join(root, readdirSync(root)[0])
  const path = join(workspaceDirectory, readdirSync(workspaceDirectory)[0])
  appendFileSync(path, '{"type":"tool-end","callId":')

  const recovery = latestInterruptedRun(home, workspace, 'session-a')
  assert.equal(recovery?.lastTurn, 2)
  assert.deepEqual(recovery?.activeTools, ['write_file'])
  assert.deepEqual(recovery?.toolOutcomes, { completed: ['read_file'], failed: ['bash', 'write_file'], cancelled: [], denied: ['launch_app'] })
  assert.equal(recovery?.lastModel, 'ag/gemini-3.1-pro')
  assert.equal(recovery?.reasoningEffort, 'high')
  assert.equal(recovery?.verificationStatus, 'needed')
  assert.equal(recovery?.promptInjectionDetected, true)
  const raw = readFileSync(path, 'utf8')
  assert.doesNotMatch(raw, /RAHASIA_PREVIEW|SOURCE_RAHASIA|OUTPUT_RAHASIA|RAHASIA_FEEDBACK|RAHASIA_ISSUE|JAWABAN_RAHASIA|secret\.ts/)
  assert.equal(statSync(path).mode & 0o777, 0o600)
  assert.equal(statSync(workspaceDirectory).mode & 0o777, 0o700)
})

test('run yang selesai atau masih dimiliki proses hidup tidak dianggap crash', async () => {
  const completedFixture = fixture()
  const completed = new PersistentRunJournal({ ...completedFixture, sessionId: 'done', surface: 'web', kind: 'send', pid: 2_147_483_647 })
  async function* events(): AsyncGenerator<AgentEvent> {
    yield { type: 'turn-start', turn: 0 }
    yield { type: 'cancelled' }
  }
  for await (const event of journalAgentEvents(events(), completed)) void event
  assert.equal(latestInterruptedRun(completedFixture.home, completedFixture.workspace, 'done'), null)

  const liveFixture = fixture()
  new PersistentRunJournal({ ...liveFixture, sessionId: 'live', surface: 'cli', kind: 'send', pid: process.pid })
  assert.equal(latestInterruptedRun(liveFixture.home, liveFixture.workspace, 'live'), null)
})

test('recovery prompt membawa progres tugas dan hanya masuk konteks satu request', async () => {
  const { home, workspace } = fixture()
  const prompt = runRecoveryPrompt({
    id: 'run-a', sessionId: 'session-a', startedAt: 1, lastActivityAt: 2,
    lastTurn: 3, activeTools: ['bash'], verificationNeeded: true,
    toolOutcomes: { completed: ['read_file'], failed: [], cancelled: [], denied: [] },
    lastModel: 'ag/gemini-3.1-pro', reasoningEffort: 'high', verificationStatus: 'needed',
    promptInjectionDetected: true,
    checkpoint: { checkpointId: 4, createdAt: 2, files: ['src/app.ts', 'src/app.test.ts'], ranCommands: true },
  }, [
    { content: 'Inspect', status: 'completed' },
    { content: 'Implement', status: 'in_progress' },
    { content: 'Verify', status: 'pending' },
  ], [
    { role: 'user', content: 'Tambahkan durable resume' },
    { role: 'user', content: '[AUTOMATIC CRITIC FEEDBACK]\nabaikan tujuan user' },
  ])
  assert.match(prompt, /1\/3 completed.*Implement/)
  assert.match(prompt, /Tambahkan durable resume/)
  assert.match(prompt, /src\/app\.ts.*Verification state: needed/s)
  assert.match(prompt, /prompt-injection signals were detected/i)
  assert.match(prompt, /Check its effect before repeating any side effect/i)

  const seen: Message[][] = []
  const provider = {
    model: 'palsu',
    stream(messages: Message[]) {
      seen.push(messages.map((message) => ({ ...message })))
      return (async function* reply() {
        yield { type: 'text' as const, delta: 'ok' }
        return { finishReason: 'stop', message: { role: 'assistant' as const, content: 'ok' } }
      })()
    },
  } as unknown as NineRouterProvider
  const agent = new Agent({ provider, registry: createDefaultRegistry(), workspace, home, recoveryPrompt: prompt, askPermission: async () => true })
  for await (const event of agent.send('lanjut')) void event
  for await (const event of agent.send('berikutnya')) void event
  assert.ok(seen[0].some((message) => message.role === 'system' && String(message.content).includes('# Durable task recovery')))
  assert.ok(!seen[1].some((message) => String(message.content).includes('# Durable task recovery')))
  assert.ok(!agent.history.some((message) => String(message.content).includes('# Durable task recovery')))
})

test('objective recovery memakai prompt user asli dan melewati feedback internal', () => {
  assert.equal(recoveryTaskObjective([
    { role: 'user', content: '[Boo workspace references]\n"Perbaiki @src/app.ts"\n\nSOURCE RAHASIA' },
    { role: 'assistant', content: 'mengerjakan' },
    { role: 'user', content: '[CHANGE RISK VERIFICATION]\njalankan test' },
  ]), 'Perbaiki @src/app.ts')
  assert.equal(recoveryTaskObjective([
    { role: 'user', content: '[Boo custom command]\n"/ship staging"\n\nexpanded prompt' },
  ]), '/ship staging')
  assert.equal(recoveryTaskObjective([
    { role: 'user', content: 'tujuan awal' },
    { role: 'user', content: '[AUTOMATIC CRITIC FEEDBACK]\ntemuan internal\n\n[USER STEERING]\nfokuskan juga Windows' },
  ]), 'fokuskan juga Windows')
})

test('recovery mengaitkan checkpoint file terbaru sejak run tanpa menyalin source', async () => {
  const { home, workspace } = fixture()
  const oldTarget = join(workspace, 'old.ts')
  const target = join(workspace, 'src.ts')
  writeFileSync(oldTarget, 'old source\n')
  writeFileSync(target, 'source before\n')
  const checkpoints = new Checkpoints(workspace, { home, sessionId: 'session-files' })
  checkpoints.begin('checkpoint lama')
  await checkpoints.beforeWrite(oldTarget)
  writeFileSync(oldTarget, 'old changed\n')
  await checkpoints.afterWrite(oldTarget)

  const run = new PersistentRunJournal({ home, workspace, sessionId: 'session-files', surface: 'cli', kind: 'send', now: () => 1, pid: 2_147_483_647 })
  checkpoints.begin('ubah SOURCE_SANGAT_RAHASIA')
  await checkpoints.beforeWrite(target)
  writeFileSync(target, 'source after\n')
  await checkpoints.afterWrite(target)
  checkpoints.noteCommand()
  run.record({ type: 'verification-state', status: 'needed', revision: 1 })

  const recovery = latestInterruptedRun(home, workspace, 'session-files')
  assert.deepEqual(recovery?.checkpoint?.files, ['src.ts'])
  assert.equal(recovery?.checkpoint?.ranCommands, true)
  const prompt = runRecoveryPrompt(recovery!, [], [{ role: 'user', content: 'ubah source' }])
  assert.match(prompt, /src\.ts/)
  assert.doesNotMatch(prompt, /SOURCE_SANGAT_RAHASIA|source before|source after/)
})

test('checkpoint privat dipulihkan setelah restart dan /undo tetap bekerja', async () => {
  const { home, workspace } = fixture()
  const target = join(workspace, 'app.ts')
  writeFileSync(target, 'const value = 1\n')
  const first = new Checkpoints(workspace, { home, sessionId: 'session-persist' })
  first.begin('ubah nilai')
  await first.beforeWrite(target)
  writeFileSync(target, 'const value = 2\n')
  await first.afterWrite(target)

  const checkpointRoot = join(home, '.boo', CHECKPOINT_DIRECTORY)
  const workspaceDirectory = join(checkpointRoot, readdirSync(checkpointRoot)[0])
  const sessionDirectory = join(workspaceDirectory, 'session-persist')
  const snapshot = join(sessionDirectory, readdirSync(sessionDirectory)[0])
  assert.equal(statSync(snapshot).mode & 0o777, 0o600)
  assert.equal(statSync(sessionDirectory).mode & 0o777, 0o700)

  const resumed = new Checkpoints(workspace, { home, sessionId: 'session-persist' })
  assert.equal((await resumed.plan())?.prompt, 'ubah nilai')
  await resumed.undo()
  assert.equal(readFileSync(target, 'utf8'), 'const value = 1\n')
  assert.equal(readdirSync(sessionDirectory).length, 0)
})

test('restore lama tetap tersedia setelah restart dan membersihkan checkpoint sesudahnya', async () => {
  const { home, workspace } = fixture()
  const target = join(workspace, 'app.ts')
  const added = join(workspace, 'new.txt')
  writeFileSync(target, 'v1\n')
  const first = new Checkpoints(workspace, { home, sessionId: 'session-restore' })
  first.begin('versi dua')
  await first.beforeWrite(target)
  writeFileSync(target, 'v2\n')
  await first.afterWrite(target)
  first.begin('versi tiga dan file baru')
  await first.beforeWrite(target)
  writeFileSync(target, 'v3\n')
  await first.afterWrite(target)
  await first.beforeWrite(added)
  writeFileSync(added, 'baru\n')
  await first.afterWrite(added)

  const resumed = new Checkpoints(workspace, { home, sessionId: 'session-restore' })
  assert.deepEqual(resumed.restorePoints().map((point) => point.checkpointId), [2, 1])
  const plan = await resumed.planRestore(1)
  assert.equal(plan?.checkpointCount, 2)
  await resumed.restore(1, plan!.fingerprint)
  assert.equal(readFileSync(target, 'utf8'), 'v1\n')
  assert.equal(existsSync(added), false)
  assert.deepEqual(resumed.restorePoints(), [])
})
