import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveUpload } from './storage.js'

test('accepts a file inside the upload root', () => {
  assert.equal(resolveUpload('/srv/uploads', 'avatars/me.png'), '/srv/uploads/avatars/me.png')
})

test('rejects parent traversal', () => {
  assert.throws(() => resolveUpload('/srv/uploads', '../secret.txt'), /escapes upload root/)
})

test('rejects a sibling directory sharing the same prefix', () => {
  assert.throws(() => resolveUpload('/srv/uploads', '../uploads-private/key.txt'), /escapes upload root/)
})

test('rejects an absolute path outside the root', () => {
  assert.throws(() => resolveUpload('/srv/uploads', '/etc/passwd'), /escapes upload root/)
})
