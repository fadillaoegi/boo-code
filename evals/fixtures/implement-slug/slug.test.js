import assert from 'node:assert/strict'
import test from 'node:test'
import { slugify } from './slug.js'

test('membuat slug URL yang stabil', () => {
  assert.equal(slugify('  Halo Dunia  '), 'halo-dunia')
  assert.equal(slugify('Boo---Code'), 'boo-code')
  assert.equal(slugify('Crème brûlée'), 'creme-brulee')
  assert.equal(slugify('___'), '')
})

test('menolak nilai bukan string', () => {
  assert.throws(() => slugify(null), TypeError)
  assert.throws(() => slugify(42), TypeError)
})
