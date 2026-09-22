import assert from 'node:assert/strict'
import test from 'node:test'
import { parseLimit, publicVersion } from './parser.js'

test('menerima nol sebagai limit yang valid', () => {
  assert.equal(parseLimit('0'), 0)
  assert.equal(parseLimit('25'), 25)
})

test('mempertahankan API publik lain', () => {
  assert.equal(publicVersion(), 'v1')
})
