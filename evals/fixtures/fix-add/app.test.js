import assert from 'node:assert/strict'
import test from 'node:test'
import { add } from './app.js'

test('menjumlahkan dua angka', () => {
  assert.equal(add(2, 3), 5)
  assert.equal(add(-2, 2), 0)
})
