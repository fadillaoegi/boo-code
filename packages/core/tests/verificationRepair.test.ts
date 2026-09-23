import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MAX_VERIFICATION_REPAIR_ROUNDS,
  VERIFICATION_REPAIR_MARK,
  VerificationRepairLoop,
} from '../src/agent/verificationRepair.ts'

test('loop repair memberi prompt sekali per state tanpa menyimpan output tool', () => {
  const loop = new VerificationRepairLoop()
  const failure = loop.recordFailure('pnpm test\n--filter unit', 1)
  assert.equal(failure.round, 1)
  const prompt = loop.takePrompt(1)
  assert.ok(prompt.includes(VERIFICATION_REPAIR_MARK))
  assert.match(prompt, /pnpm test --filter unit/)
  assert.match(prompt, /Belum ada perubahan source/)
  assert.doesNotMatch(prompt, /output|stack trace/i)
  assert.equal(loop.takePrompt(1), '')
  assert.match(loop.takePrompt(2), /revisi 1 ke 2/)
})

test('kesimpulan prematur dibatasi lalu loop berakhir exhausted', () => {
  const loop = new VerificationRepairLoop()
  loop.recordFailure('node --test', 1)
  assert.equal(loop.onIncompleteConclusion(1).action, 'retry')
  const second = loop.onIncompleteConclusion(1)
  assert.equal(second.action, 'retry')
  assert.equal(second.action === 'retry' && second.round, MAX_VERIFICATION_REPAIR_ROUNDS)
  const exhausted = loop.onIncompleteConclusion(1)
  assert.equal(exhausted.action, 'exhausted')
  assert.equal(exhausted.action === 'exhausted' && exhausted.round, MAX_VERIFICATION_REPAIR_ROUNDS)
})

test('verifikasi sukses menutup loop dan mengembalikan jumlah putaran', () => {
  const loop = new VerificationRepairLoop()
  loop.recordFailure('pnpm test', 1)
  loop.onIncompleteConclusion(1)
  assert.equal(loop.recordSuccess(), 2)
  assert.equal(loop.active, false)
  assert.equal(loop.takePrompt(2), '')
  assert.deepEqual(loop.onIncompleteConclusion(2), { action: 'none' })
  assert.equal(loop.recordSuccess(), 0)
})
