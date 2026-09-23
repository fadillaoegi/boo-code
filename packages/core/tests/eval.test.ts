import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEvalWorkspaceSnapshot, evaluateAgentRun, summarizeAgentRun } from '../src/eval/harness.ts'
import { compareEvalBaseline, createEvalBaseline, createEvalRunReport, parseEvalBaseline, parseEvalSuite, selectEvalCases, validateEvalCoverage, validateEvalFixtures } from '../src/eval/benchmark.ts'
import type { AgentEvent } from '../src/agent/loop.ts'

const events: AgentEvent[] = [
  { type: 'turn-start', turn: 0 },
  { type: 'tool-start', name: 'edit_file', preview: 'ubah app.js', callId: '1', args: {} },
  { type: 'tool-end', name: 'edit_file', callId: '1', content: 'ok', isError: false, cancelled: false },
  { type: 'turn-start', turn: 1 },
  { type: 'verification-needed', files: ['app.js'] },
  { type: 'change-impact', changedFiles: 1, affectedFiles: 3, tests: 1, edges: 4, maxDepth: 2, blastRadius: 'small', truncated: false },
  { type: 'lsp-session', stage: 'started', openDocuments: 1 },
  { type: 'lsp-session', stage: 'reused', openDocuments: 2 },
  { type: 'verification-repair', stage: 'needed', round: 1, maxRounds: 3, revision: 1 },
  { type: 'tool-start', name: 'bash', preview: 'node --test', callId: '2', args: {} },
  { type: 'tool-end', name: 'bash', callId: '2', content: 'ok', isError: false, cancelled: false },
  { type: 'verification-repair', stage: 'repaired', round: 1, maxRounds: 3, revision: 1 },
  { type: 'turn-start', turn: 2 },
  { type: 'context-trimmed', droppedMessages: 4, estimatedTokens: 900, prioritizedMessages: 2, dependencyMessages: 3, dependencyEdges: 2 },
  { type: 'text', delta: 'Selesai dan test lulus.' },
]

test('ringkasan eval menghitung turn, tool, kegagalan, dan verifikasi', () => {
  assert.deepEqual(summarizeAgentRun(events), {
    turns: 3,
    toolCalls: 2,
    toolFailures: 0,
    retries: 0,
    tools: { edit_file: 1, bash: 1 },
    verificationRequested: true,
    verificationIncomplete: false,
    verificationRepairRounds: 1,
    verificationRepairs: 1,
    verificationRepairExhausted: 0,
    changeImpactAnalyses: 1,
    changeImpactAffectedFiles: 3,
    changeImpactEdges: 4,
    changeImpactLarge: 0,
    lspSessionStarts: 1,
    lspSessionReuses: 1,
    lspSessionRestarts: 0,
    contextDependencyMessages: 3,
    contextDependencyEdges: 2,
  })
})

test('eval memberi skor dari artefak, perilaku tool, dan batas kerja', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'boo-eval-grade-'))
  const content = 'export const value = 2\n'
  writeFileSync(join(workspace, 'app.js'), content)
  const result = evaluateAgentRun(workspace, events, {
    files: [{ path: 'app.js', contains: 'value = 2', notContains: 'value = 1', sha256: createHash('sha256').update(content).digest('hex') }],
    requiredTools: ['edit_file', 'bash'],
    forbiddenTools: ['write_file'],
    requireVerification: true,
    maxTurns: 3,
    maxToolCalls: 2,
    answerContains: 'test lulus',
  })
  assert.equal(result.passed, true)
  assert.equal(result.score, 100)
  assert.ok(result.checks.length >= 9)
})

test('eval gagal bila file atau bukti verifikasi tidak sesuai', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'boo-eval-grade-'))
  const incomplete = [...events, { type: 'verification-incomplete' as const, files: ['app.js'], attempted: true }]
  const result = evaluateAgentRun(workspace, incomplete, {
    files: [{ path: 'hilang.js' }],
    requireVerification: true,
  })
  assert.equal(result.passed, false)
  assert.equal(result.score, 0)
})

test('eval mengunci file yang boleh berubah berdasarkan snapshot awal', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'boo-eval-changes-'))
  writeFileSync(join(workspace, 'app.js'), 'old\n')
  writeFileSync(join(workspace, 'app.test.js'), 'do not edit\n')
  const before = createEvalWorkspaceSnapshot(workspace)
  writeFileSync(join(workspace, 'app.js'), 'fixed\n')

  const passing = evaluateAgentRun(workspace, events, {
    requiredChangedFiles: ['app.js'],
    allowedChangedFiles: ['app.js'],
    forbiddenChangedFiles: ['app.test.js'],
    maxChangedFiles: 1,
    answerNotContains: 'gagal',
  }, before)
  assert.equal(passing.passed, true)
  assert.deepEqual(passing.metrics.changedFiles, ['app.js'])

  writeFileSync(join(workspace, 'unexpected.txt'), 'shortcut\n')
  const failing = evaluateAgentRun(workspace, events, { allowedChangedFiles: ['app.js'] }, before)
  assert.equal(failing.passed, false)
  assert.match(failing.checks.find((check) => check.name === 'changed-files:allowed')?.detail ?? '', /unexpected\.txt/)
})

test('kontrak perubahan gagal aman tanpa snapshot awal', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'boo-eval-no-snapshot-'))
  const result = evaluateAgentRun(workspace, events, { allowedChangedFiles: [] })
  assert.equal(result.passed, false)
  assert.equal(result.checks[0]?.name, 'changed-files:snapshot')
})

const validSuite = () => ({
  schemaVersion: 1,
  name: 'Regression',
  model: 'auto',
  cases: [
    {
      id: 'fix-one',
      prompt: 'Perbaiki bug.',
      fixture: 'fixtures/one',
      tags: ['debugging', 'javascript'],
      allowedCommands: ['node --test'],
      expect: { files: [{ path: 'app.js', contains: 'fixed' }], requireVerification: true, maxTurns: 8 },
    },
    {
      id: 'inspect-two',
      prompt: 'Jelaskan proyek.',
      fixture: 'fixtures/two',
      tags: ['investigation'],
      expect: { answerContains: 'jawaban' },
    },
  ],
})

test('schema benchmark dinormalisasi dan menolak ID duplikat atau expectation kosong', () => {
  const suite = parseEvalSuite(validSuite())
  assert.equal(suite.schemaVersion, 1)
  assert.deepEqual(suite.cases[1].allowedCommands, [])
  const duplicate = validSuite()
  duplicate.cases[1].id = 'fix-one'
  assert.throws(() => parseEvalSuite(duplicate), /ID kasus duplikat/)
  const empty = validSuite()
  Object.assign(empty.cases[0], { expect: {} })
  assert.throws(() => parseEvalSuite(empty), /minimal satu pemeriksaan/)
  assert.throws(() => parseEvalSuite({ ...validSuite(), typo: true }), /field tidak dikenal: typo/)
  const noChanges = validSuite()
  Object.assign(noChanges.cases[0], { expect: { allowedChangedFiles: [], maxChangedFiles: 0 } })
  assert.deepEqual(parseEvalSuite(noChanges).cases[0].expect, { allowedChangedFiles: [], maxChangedFiles: 0 })
})

test('coverage suite melaporkan kategori dan difficulty yang belum terwakili', () => {
  const suite = parseEvalSuite({
    ...validSuite(),
    coverage: {
      minCases: 3,
      requiredTags: ['debugging', 'security'],
      requiredDifficulties: ['standard', 'expert'],
    },
  })
  assert.deepEqual(validateEvalCoverage(suite), [
    'jumlah kasus 2, minimum 3',
    'tag wajib belum tercakup: security',
    'difficulty wajib belum tercakup: standard, expert',
  ])
})

test('filter kasus menggabungkan id dan tag dengan aman', () => {
  const suite = parseEvalSuite(validSuite())
  assert.deepEqual(selectEvalCases(suite, [], ['debugging']).map((item) => item.id), ['fix-one'])
  assert.deepEqual(selectEvalCases(suite, ['inspect-two'], ['debugging']), [])
  assert.deepEqual(selectEvalCases(suite, ['inspect-two'], ['investigation']).map((item) => item.id), ['inspect-two'])
})

test('validasi fixture dapat berjalan tanpa provider', () => {
  const root = mkdtempSync(join(tmpdir(), 'boo-eval-suite-'))
  mkdirSync(join(root, 'fixtures', 'one'), { recursive: true })
  const suite = parseEvalSuite(validSuite())
  assert.deepEqual(validateEvalFixtures(suite, join(root, 'suite.json')), [
    `inspect-two: fixture tidak ditemukan (${join(root, 'fixtures', 'two')})`,
  ])
})

test('laporan dan baseline mendeteksi regresi, peningkatan, kasus baru, dan toleransi', () => {
  const previous = createEvalRunReport({
    suite: 'Regression', model: 'auto', startedAt: new Date('2026-01-01T00:00:00Z'), durationMs: 50,
    cases: [
      { id: 'stable', tags: ['debugging'], score: 100, passed: true, durationMs: 10 },
      { id: 'weak', tags: ['coding'], score: 50, passed: false, durationMs: 10 },
    ],
  })
  const baseline = parseEvalBaseline(createEvalBaseline(previous))
  const current = createEvalRunReport({
    suite: 'Regression', model: 'auto', startedAt: new Date('2026-01-02T00:00:00Z'), durationMs: 80,
    cases: [
      { id: 'stable', tags: ['debugging'], score: 95, passed: true, durationMs: 10 },
      { id: 'weak', tags: ['coding'], score: 100, passed: true, durationMs: 10 },
      { id: 'new', tags: ['safety'], score: 100, passed: true, durationMs: 10 },
    ],
  })
  const strict = compareEvalBaseline(current, baseline)
  assert.equal(strict.passed, false)
  assert.deepEqual(strict.regressions.map((item) => item.id), ['stable'])
  assert.deepEqual(strict.improvements, ['weak'])
  assert.deepEqual(strict.newCases, ['new'])
  assert.equal(compareEvalBaseline(current, baseline, 5).passed, true)
  assert.throws(() => compareEvalBaseline({ ...current, suite: 'Other' }, baseline), /bukan/)
})
