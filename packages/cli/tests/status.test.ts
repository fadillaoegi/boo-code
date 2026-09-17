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
