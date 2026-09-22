import assert from 'node:assert/strict'
import test from 'node:test'
import { formatName } from './src/format.js'

test('merapikan spasi dan mengurutkan nama secara natural', () => {
  assert.equal(formatName('  Budi ', ' Santoso  '), 'Budi Santoso')
  assert.equal(formatName('Ayu', 'Lestari'), 'Ayu Lestari')
})
