import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findApp, loadApps, openAppTool } from '../src/tools/apps.ts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'boo-apps-'))
  const home = join(root, 'home')
  const workspace = join(root, 'workspace')
  await Promise.all([mkdir(join(home, '.boo'), { recursive: true }), mkdir(join(workspace, '.boo'), { recursive: true })])
  return { home, workspace }
}

test('aplikasi global dan proyek digabung; alias proyek menimpa global', async () => {
  const { home, workspace } = await fixture()
  await writeFile(join(home, '.boo', 'apps.json'), JSON.stringify({ apps: [
    { id: 'editor', label: 'Editor lama', command: 'old-editor' },
    { id: 'browser', label: 'Browser', command: 'browser' },
  ] }))
  await writeFile(join(workspace, '.boo', 'apps.json'), JSON.stringify({ apps: [
    { id: 'editor', label: 'Editor proyek', command: 'new-editor', args: ['.'] },
  ] }))

  const catalog = loadApps(workspace, home, 'linux')
  assert.deepEqual(catalog.apps.map((app) => app.id), ['browser', 'editor'])
  assert.deepEqual(findApp(catalog, 'EDITOR'), { id: 'editor', label: 'Editor proyek', command: 'new-editor', args: ['.'] })
})

test('konfigurasi dapat memakai command berbeda per sistem operasi', async () => {
  const { home, workspace } = await fixture()
  await writeFile(join(home, '.boo', 'apps.json'), JSON.stringify({ apps: [{
    id: 'notes', command: 'notes-linux', platforms: {
      darwin: { command: 'open', args: ['-a', 'Notes'] },
      win32: { command: 'notepad.exe' },
    },
  }] }))
  assert.deepEqual(findApp(loadApps(workspace, home, 'darwin'), 'notes'), { id: 'notes', label: 'notes', command: 'open', args: ['-a', 'Notes'] })
  assert.deepEqual(findApp(loadApps(workspace, home, 'win32'), 'notes'), { id: 'notes', label: 'notes', command: 'notepad.exe', args: [] })
  assert.deepEqual(findApp(loadApps(workspace, home, 'linux'), 'notes'), { id: 'notes', label: 'notes', command: 'notes-linux', args: [] })
})

test('entri tidak valid diabaikan dan tool tidak membuka alias yang tidak terdaftar', async () => {
  const { home, workspace } = await fixture()
  await writeFile(join(home, '.boo', 'apps.json'), JSON.stringify({ apps: [
    { id: '../buruk', command: 'anything' },
    { id: 'valid', command: 'program', args: ['satu'] },
  ] }))
  const catalog = loadApps(workspace, home, 'linux')
  assert.equal(catalog.apps.length, 1)
  assert.ok(catalog.issues.length)
  const result = await openAppTool.run({ id: 'tidak-ada' }, { workspace })
  assert.equal(result.isError, true)
  assert.match(result.content, /tidak terdaftar/)
})
