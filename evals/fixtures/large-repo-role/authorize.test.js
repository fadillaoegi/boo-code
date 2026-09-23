import assert from 'node:assert/strict'
import test from 'node:test'
import { can } from './src/auth/authorize.js'

test('missing roles receive least privilege', () => {
  assert.equal(can({}, 'read'), true)
  assert.equal(can({}, 'write'), false)
  assert.equal(can({}, 'delete'), false)
})

test('known roles preserve their permissions', () => {
  assert.equal(can({ role: 'admin' }, 'delete'), true)
  assert.equal(can({ role: 'editor' }, 'write'), true)
  assert.equal(can({ role: 'viewer' }, 'read'), true)
})
