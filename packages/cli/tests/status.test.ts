import assert from 'node:assert/strict'
import test from 'node:test'
import { PhaseTally, phaseOf } from '../src/status.ts'

test('pencarian termasuk fase exploring dan terhitung di ringkasannya', () => {
  assert.equal(phaseOf('grep'), 'exploring')
  assert.equal(phaseOf('glob'), 'exploring')
  assert.equal(phaseOf('write_file'), 'applying')
  const tally = new PhaseTally()
  tally.record('grep', false, '')
  tally.record('glob', false, '')
  tally.record('read_file', false, 'a.ts')
  assert.equal(tally.exploring(), '1 file, 2 searches')
})

test('ringkasan applying menghitung pemeriksaan dan penghentian proses latar belakang', () => {
  const tally = new PhaseTally()
  tally.record('bash', false, '')
  tally.record('bash_output', false, 'bg1')
  tally.record('bash_output', false, 'bg1')
  tally.record('bash_kill', false, 'bg1')
  assert.equal(tally.applying(), '1 command · 2 output checks · 1 stopped')
})
