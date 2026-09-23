import assert from 'node:assert/strict'
import test from 'node:test'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  classifyCommandTimeout,
  loadToolTimeoutProfile,
  parseToolTimeoutProfile,
  recordToolTimeoutObservation,
  saveToolTimeoutProfile,
  selectAdaptiveTimeout,
  TOOL_TIMEOUT_MAX_AGE_MS,
  toolTimeoutProfileFile,
} from '../src/tools/adaptiveTimeout.ts'
import { resolveShell, runCommand } from '../src/tools/shell.ts'

test('command diklasifikasikan tanpa menyimpan teks atau argumennya', () => {
  assert.equal(classifyCommandTimeout('git status --short'), 'quick')
  assert.equal(classifyCommandTimeout('pnpm test'), 'test')
  assert.equal(classifyCommandTimeout('flutter build appbundle'), 'build')
  assert.equal(classifyCommandTimeout('pnpm install'), 'install')
  assert.equal(classifyCommandTimeout('curl https://example.com'), 'network')
  assert.equal(classifyCommandTimeout('pnpm dev'), 'long-running')
  assert.equal(classifyCommandTimeout('node script.js'), 'general')
})

test('timeout eksplisit tetap hard limit, sedangkan kebijakan adaptif belajar dari timeout', () => {
  const explicit = selectAdaptiveTimeout('pnpm test', 7.6)
  assert.deepEqual(explicit, {
    category: 'test', mode: 'explicit', idleSeconds: 8, maximumSeconds: 8,
    learnedSamples: 0, reason: 'timeout eksplisit 8 detik',
  })

  const first = selectAdaptiveTimeout('git status', undefined)
  assert.equal(first.idleSeconds, 45)
  assert.equal(first.maximumSeconds, 90)
  const profile = recordToolTimeoutObservation(undefined, 'quick', 200_000, true, 123)
  const learned = selectAdaptiveTimeout('git status', undefined, profile, 123)
  assert.equal(learned.idleSeconds, 300)
  assert.equal(learned.maximumSeconds, 600)
  assert.equal(learned.learnedSamples, 1)
  assert.equal(selectAdaptiveTimeout('git status', undefined, profile, 123 + TOOL_TIMEOUT_MAX_AGE_MS + 1).learnedSamples, 0)
})

test('profil timeout privat pulih aman dari file korup dan schema invalid', () => {
  const home = mkdtempSync(join(tmpdir(), 'boo-timeout-profile-'))
  const profile = recordToolTimeoutObservation(undefined, 'test', 2_000, false, 100)
  const path = saveToolTimeoutProfile(home, profile)
  const stored = readFileSync(path, 'utf8')
  assert.doesNotMatch(stored, /pnpm|command|source/i)
  assert.deepEqual(loadToolTimeoutProfile(home), profile)

  writeFileSync(path, '{rusak', 'utf8')
  assert.deepEqual(loadToolTimeoutProfile(home).stats, [])
  chmodSync(path, 0o600)
  assert.throws(() => parseToolTimeoutProfile({ schemaVersion: 1, updatedAt: 1, stats: [{ category: 'unknown' }] }), /tidak valid/)
  assert.equal(toolTimeoutProfileFile(home), path)
})

test('progres memperpanjang idle deadline tetapi hard cap tetap menghentikan command', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'boo-adaptive-shell-'))
  const shell = resolveShell()
  const progressive = "let n=0;const timer=setInterval(()=>{console.log(++n);if(n===5)clearInterval(timer)},50)"
  const completed = await runCommand(`node -e ${JSON.stringify(progressive)}`, {
    cwd: workspace,
    shell,
    sandbox: { mode: 'danger-full-access' },
    timeoutMs: 250,
    maxRuntimeMs: 1_000,
  })
  assert.equal(completed.timedOut, false)
  assert.match(completed.output, /5/)
  assert.ok(completed.durationMs >= 200)

  const endlessProgress = "setInterval(()=>console.log('tick'),30)"
  const capped = await runCommand(`node -e ${JSON.stringify(endlessProgress)}`, {
    cwd: workspace,
    shell,
    sandbox: { mode: 'danger-full-access' },
    timeoutMs: 1_000,
    maxRuntimeMs: 1_300,
  })
  assert.equal(capped.timedOut, true)
  assert.equal(capped.timeoutReason, 'maximum')
  assert.match(capped.output, /tick/)
})

test('command tanpa progres berhenti pada idle deadline dan mempertahankan output awal', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'boo-adaptive-idle-'))
  const script = "console.log('mulai');setTimeout(()=>console.log('terlambat'),1200)"
  const result = await runCommand(`node -e ${JSON.stringify(script)}`, {
    cwd: workspace,
    shell: resolveShell(),
    sandbox: { mode: 'danger-full-access' },
    timeoutMs: 500,
    maxRuntimeMs: 2_000,
  })
  assert.equal(result.timedOut, true)
  assert.equal(result.timeoutReason, 'idle')
  assert.match(result.output, /mulai/)
  assert.doesNotMatch(result.output, /terlambat/)
})
