import assert from 'node:assert/strict'
import test from 'node:test'
import { checkoutTotal } from './src/cart.js'

test('menghitung subtotal dan pajak untuk seluruh keranjang', () => {
  const items = [{ price: 20, quantity: 2 }, { price: 10, quantity: 1 }]
  assert.equal(checkoutTotal(items, 0.1), 55)
  assert.equal(checkoutTotal(items, 0), 50)
})
