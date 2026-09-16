import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveInWorkspace, WorkspaceError } from '../src/tools/workspace.ts'

const WORKSPACE = '/tmp/boo-workspace'

test('path relatif diselesaikan ke dalam workspace', () => {
  assert.equal(resolveInWorkspace(WORKSPACE, 'src/app.ts'), '/tmp/boo-workspace/src/app.ts')
  assert.equal(resolveInWorkspace(WORKSPACE, './README.md'), '/tmp/boo-workspace/README.md')
})

test('path yang keluar lewat .. ditolak', () => {
  assert.throws(() => resolveInWorkspace(WORKSPACE, '../rahasia.txt'), WorkspaceError)
  assert.throws(() => resolveInWorkspace(WORKSPACE, 'src/../../../etc/passwd'), WorkspaceError)
})

test('path absolut di luar workspace ditolak', () => {
  assert.throws(() => resolveInWorkspace(WORKSPACE, '/etc/passwd'), WorkspaceError)
  assert.throws(() => resolveInWorkspace(WORKSPACE, '/Users/boo/.ssh/id_rsa'), WorkspaceError)
})

test('path absolut di dalam workspace diterima', () => {
  assert.equal(resolveInWorkspace(WORKSPACE, '/tmp/boo-workspace/src/a.ts'), '/tmp/boo-workspace/src/a.ts')
})

test('nama yang berawalan sama tidak lolos', () => {
  // '/tmp/boo-workspace-lain' bukan bagian dari '/tmp/boo-workspace'.
  assert.throws(() => resolveInWorkspace(WORKSPACE, '../boo-workspace-lain/x.ts'), WorkspaceError)
})
