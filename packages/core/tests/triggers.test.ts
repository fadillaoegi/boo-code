import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  addEventTrigger,
  authorizeWebhookTrigger,
  claimEventTriggers,
  enqueueCustomTrigger,
  enqueueWebhookTrigger,
  finishEventTriggerRun,
  loadEventTriggers,
  parseTriggerDuration,
  removeEventTrigger,
  setEventTriggerEnabled,
  TRIGGER_RUNS_FILE,
} from '../src/automation/triggers.ts'

const fingerprint = (character: string) => character.repeat(64)

test('file trigger seeds a baseline, debounces changes, and stores private metadata', async () => {
  const home = mkdtempSync(join(tmpdir(), 'boo-trigger-'))
  const workspace = mkdtempSync(join(tmpdir(), 'boo-trigger-work-'))
  const created = addEventTrigger({
    prompt: 'jalankan test terkait', workspace, source: { kind: 'file', pattern: 'src/**/*.ts' }, debounceMs: 2_000, now: 1_000,
  }, home).trigger
  const observeA = { file: async () => fingerprint('a') }
  const observeB = { file: async () => fingerprint('b') }
  assert.deepEqual(await claimEventTriggers(home, 1_000, 10, observeA), [])
  assert.deepEqual(await claimEventTriggers(home, 2_000, 10, observeB), [])
  const dispatches = await claimEventTriggers(home, 4_000, 10, observeB)
  assert.equal(dispatches.length, 1)
  assert.equal(dispatches[0].trigger.id, created.id)
  assert.equal(dispatches[0].reason, 'file:src/**/*.ts')
  assert.deepEqual(await claimEventTriggers(home, 5_000, 10, observeB), [])
  finishEventTriggerRun(created.id, 1, 4_000, home, 4_100)
  const updated = loadEventTriggers(home).triggers[0]
  assert.equal(updated.runs, 1)
  assert.equal(updated.failures, 1)
  assert.equal(statSync(join(home, '.boo', 'triggers.json')).mode & 0o777, 0o600)
  const runLog = readFileSync(join(home, '.boo', TRIGGER_RUNS_FILE), 'utf8')
  assert.match(runLog, new RegExp(created.id))
  assert.doesNotMatch(runLog, /jalankan test terkait/)
})

test('default file observer detects a real workspace change', async () => {
  const home = mkdtempSync(join(tmpdir(), 'boo-trigger-'))
  const workspace = mkdtempSync(join(tmpdir(), 'boo-trigger-work-'))
  mkdirSync(join(workspace, 'src'))
  writeFileSync(join(workspace, 'src', 'app.ts'), 'export const value = 1\n')
  addEventTrigger({ prompt: 'verify app', workspace, source: { kind: 'file', pattern: 'src/**/*.ts' }, debounceMs: 0 }, home)
  assert.deepEqual(await claimEventTriggers(home, 1_000), [])
  writeFileSync(join(workspace, 'src', 'app.ts'), 'export const value = 12345\n')
  const dispatches = await claimEventTriggers(home, 2_000)
  assert.equal(dispatches.length, 1)
  assert.equal(dispatches[0].reason, 'file:src/**/*.ts')
})

test('git and named custom triggers are claimed without executing arbitrary event data', async () => {
  const home = mkdtempSync(join(tmpdir(), 'boo-trigger-'))
  const workspace = mkdtempSync(join(tmpdir(), 'boo-trigger-work-'))
  const git = addEventTrigger({ prompt: 'review commit', workspace, source: { kind: 'git' }, debounceMs: 0 }, home).trigger
  const custom = addEventTrigger({ prompt: 'diagnose CI', workspace, source: { kind: 'custom', event: 'build.failed' }, debounceMs: 0 }, home).trigger
  assert.deepEqual(await claimEventTriggers(home, 1_000, 10, { git: async () => fingerprint('1') }), [])
  const commit = await claimEventTriggers(home, 2_000, 10, { git: async () => fingerprint('2') })
  assert.equal(commit[0].trigger.id, git.id)
  assert.equal(enqueueCustomTrigger('build.failed', home, 3_000), 1)
  const emitted = await claimEventTriggers(home, 3_000, 10, { git: async () => fingerprint('2') })
  assert.equal(emitted[0].trigger.id, custom.id)
  assert.equal(emitted[0].reason, 'custom:build.failed')
})

test('webhook stores only a token hash and rejects invalid authorization', async () => {
  const home = mkdtempSync(join(tmpdir(), 'boo-trigger-'))
  const workspace = mkdtempSync(join(tmpdir(), 'boo-trigger-work-'))
  const created = addEventTrigger({ prompt: 'handle webhook', workspace, source: { kind: 'webhook' }, debounceMs: 0 }, home)
  assert.ok(created.webhookToken)
  const stored = readFileSync(join(home, '.boo', 'triggers.json'), 'utf8')
  assert.doesNotMatch(stored, new RegExp(created.webhookToken!))
  assert.equal(authorizeWebhookTrigger(created.trigger.id, 'wrong', home), null)
  assert.equal(authorizeWebhookTrigger(created.trigger.id, created.webhookToken!, home)?.id, created.trigger.id)
  assert.equal(enqueueWebhookTrigger(created.trigger.id, 'wrong', home), false)
  assert.equal(enqueueWebhookTrigger(created.trigger.id, created.webhookToken!, home, 2_000), true)
  const dispatches = await claimEventTriggers(home, 2_000)
  assert.equal(dispatches[0].reason, 'webhook')
})

test('trigger validation blocks traversal and supports enable, remove, and durations', () => {
  const home = mkdtempSync(join(tmpdir(), 'boo-trigger-'))
  const workspace = mkdtempSync(join(tmpdir(), 'boo-trigger-work-'))
  assert.throws(() => addEventTrigger({ prompt: 'bad', workspace, source: { kind: 'file', pattern: '../**/*' } }, home), /keluar dari workspace/)
  assert.equal(parseTriggerDuration('500ms'), 500)
  assert.equal(parseTriggerDuration('2s'), 2_000)
  assert.equal(parseTriggerDuration('25h'), null)
  const trigger = addEventTrigger({ prompt: 'ok', workspace, source: { kind: 'custom', event: 'ci.done' } }, home).trigger
  assert.equal(setEventTriggerEnabled(trigger.id, false, home)?.enabled, false)
  assert.equal(removeEventTrigger(trigger.id, home), true)
  assert.equal(loadEventTriggers(home).triggers.length, 0)
})

test('poll limit leaves excess file triggers pending for the next tick', async () => {
  const home = mkdtempSync(join(tmpdir(), 'boo-trigger-'))
  const workspace = mkdtempSync(join(tmpdir(), 'boo-trigger-work-'))
  for (let index = 0; index < 11; index += 1) {
    addEventTrigger({ prompt: `task ${index}`, workspace, source: { kind: 'file', pattern: `src/${index}.ts` }, debounceMs: 0 }, home)
  }
  await claimEventTriggers(home, 1_000, 10, { file: async () => fingerprint('a') })
  assert.equal((await claimEventTriggers(home, 2_000, 10, { file: async () => fingerprint('b') })).length, 10)
  assert.equal((await claimEventTriggers(home, 3_000, 10, { file: async () => fingerprint('b') })).length, 1)
})
