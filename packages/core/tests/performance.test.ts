import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AUTO_PERFORMANCE_MAX_AGE_MS,
  autoPerformanceFile,
  inferPerformanceTags,
  loadAutoPerformanceProfile,
  parseAutoPerformanceProfile,
  saveAutoPerformanceProfile,
  selectByPerformance,
  updateAutoPerformanceProfile,
  type AutoPerformanceProfile,
  type AutoPerformanceStat,
} from '../src/provider/performance.ts'
import { createEvalRunReport } from '../src/eval/benchmark.ts'

function stat(model: string, options: Partial<AutoPerformanceStat> = {}): AutoPerformanceStat {
  return {
    model,
    difficulty: 'standard',
    tag: '*',
    samples: 4,
    passes: 3,
    scoreTotal: 320,
    durationMsTotal: 4_000,
    retries: 0,
    toolFailures: 0,
    updatedAt: 10_000,
    ...options,
  }
}

function profile(stats: AutoPerformanceStat[]): AutoPerformanceProfile {
  return { schemaVersion: 1, updatedAt: 10_000, stats }
}

test('profil performa disimpan privat dan dapat dimuat tanpa data percakapan', () => {
  const home = mkdtempSync(join(tmpdir(), 'boo-performance-home-'))
  const value = profile([stat('model-a')])
  const path = saveAutoPerformanceProfile(home, value)
  assert.equal(path, autoPerformanceFile(home))
  assert.deepEqual(loadAutoPerformanceProfile(home), value)
  assert.equal(statSync(path).mode & 0o777, 0o600)
  assert.equal(statSync(join(home, '.boo')).mode & 0o777, 0o700)
  assert.doesNotMatch(readFileSync(path, 'utf8'), /prompt|source|answer/)
})

test('laporan benchmark digabung per model, difficulty, dan tag', () => {
  const report = createEvalRunReport({
    suite: 'routing', model: 'model-a', startedAt: new Date(0), durationMs: 100,
    cases: [{
      id: 'debug', tags: ['debugging'], score: 80, passed: true, durationMs: 90,
      metrics: {
        turns: 2, toolCalls: 2, toolFailures: 1, retries: 1, tools: {}, model: 'model-a',
        reasoningEffort: 'high', difficulty: 'standard', verificationRequested: true, verificationIncomplete: false,
      },
    }],
  })
  const updated = updateAutoPerformanceProfile(null, report, 50_000)
  assert.equal(updated.stats.length, 2, 'agregat umum dan tag kasus disimpan')
  assert.deepEqual(updated.stats.map((item) => item.tag), ['*', 'debugging'])
  assert.ok(updated.stats.every((item) => item.model === 'model-a' && item.reasoningEffort === 'high' && item.samples === 1))
  assert.equal(updated.stats[0].toolFailures, 1)
})

test('router performa memerlukan dua kandidat, tiga sampel, dan data segar', () => {
  const options = [
    { level: '', label: 'A', modelId: 'model-a' },
    { level: '', label: 'B', modelId: 'model-b' },
  ]
  const measured = profile([
    stat('model-a', { passes: 2, scoreTotal: 260 }),
    stat('model-b', { passes: 4, scoreTotal: 390 }),
  ])
  assert.equal(selectByPerformance(options, 'standard', [], measured, 10_000)?.option.modelId, 'model-b')
  assert.equal(selectByPerformance(options, 'standard', [], profile([stat('model-a')]), 10_000), null)
  assert.equal(selectByPerformance(options, 'standard', [], profile([
    stat('model-a', { samples: 2, passes: 2, scoreTotal: 200 }),
    stat('model-b'),
  ]), 10_000), null)
  assert.equal(selectByPerformance(options, 'standard', [], measured, 10_000 + AUTO_PERFORMANCE_MAX_AGE_MS + 1), null)
})

test('tag task memberi sinyal tambahan tanpa mengganti klasifikasi difficulty', () => {
  assert.deepEqual(inferPerformanceTags('Perbaiki bug API dan tambahkan regression test'), ['debugging', 'implementation', 'api', 'testing'])
  const options = [
    { level: '', label: 'A', modelId: 'model-a' },
    { level: '', label: 'B', modelId: 'model-b' },
  ]
  const measured = profile([
    stat('model-a', { passes: 4, scoreTotal: 380 }),
    stat('model-b', { passes: 4, scoreTotal: 372 }),
    stat('model-a', { tag: 'debugging', samples: 2, passes: 0, scoreTotal: 80 }),
    stat('model-b', { tag: 'debugging', samples: 2, passes: 2, scoreTotal: 200 }),
  ])
  assert.equal(selectByPerformance(options, 'standard', ['debugging'], measured, 10_000)?.option.modelId, 'model-b')
})

test('parser menolak statistik korup', () => {
  assert.throws(() => parseAutoPerformanceProfile({ schemaVersion: 1, updatedAt: 1, stats: [{ ...stat('x'), passes: 99 }] }), /tidak valid/)
  assert.equal(loadAutoPerformanceProfile('/path/yang/tidak/ada'), null)
})
