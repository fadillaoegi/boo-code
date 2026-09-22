import assert from 'node:assert/strict'
import test from 'node:test'
import { PhaseTally, phaseOf, StatusLine } from '../src/status.ts'

test('pencarian termasuk fase exploring dan terhitung di ringkasannya', () => {
  assert.equal(phaseOf('grep'), 'exploring')
  assert.equal(phaseOf('tool_search'), 'exploring')
  assert.equal(phaseOf('glob'), 'exploring')
  assert.equal(phaseOf('delegate'), 'exploring')
  assert.equal(phaseOf('write_file'), 'applying')
  const tally = new PhaseTally()
  tally.record('grep', false, '')
  tally.record('glob', false, '')
  tally.record('read_file', false, 'a.ts')
  assert.equal(tally.exploring(), '1 file, 2 searches')

  tally.record('delegate', false, '')
  assert.equal(tally.exploring(), '1 file, 2 searches, 1 delegation')
})

test('ringkasan applying menghitung pemeriksaan dan penghentian proses latar belakang', () => {
  const tally = new PhaseTally()
  tally.record('bash', false, '')
  tally.record('bash_output', false, 'bg1')
  tally.record('bash_output', false, 'bg1')
  tally.record('bash_kill', false, 'bg1')
  assert.equal(tally.applying(), '1 command · 2 output checks · 1 stopped')
})

test('fase tanpa tool yang selesai tidak dibekukan menjadi ringkasan kosong', () => {
  const written: string[] = []
  const status = new StatusLine((text) => written.push(text))
  // Model menyiapkan glob lalu bash sekaligus: fase berganti sebelum apa pun berjalan.
  status.work('exploring', 'Searching', '**/*.js')
  status.work('applying', 'Running', 'node --version')
  status.work('exploring', 'Searching', 'TODO')
  assert.deepEqual(written, [])

  status.update('2 searches')
  status.work('applying', 'Running', 'node --version')
  assert.equal(written.length, 1)
  assert.match(written[0], /Exploring.*2 searches/)
  status.commit()
  assert.equal(written.length, 1, 'applying belum punya hasil')
})
