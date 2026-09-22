import assert from 'node:assert/strict'
import test from 'node:test'
import { discountedPrice } from './price.js'

test('mengurangi harga berdasarkan persentase', () => {
  assert.equal(discountedPrice(200, 25), 150)
  assert.equal(discountedPrice(99, 0), 99)
  assert.equal(discountedPrice(80, 100), 0)
})

test('menolak nilai di luar rentang', () => {
  assert.throws(() => discountedPrice(-1, 10), RangeError)
  assert.throws(() => discountedPrice(100, 101), RangeError)
})
