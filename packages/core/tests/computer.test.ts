import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { callComputerBridge, computerSnapshotTool, computerTypeTool, loadComputerBridge } from '../src/tools/computer.ts'

const fixtureBridge = join(import.meta.dirname, 'fixtures', 'fake-computer-bridge.mjs')

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'boo-computer-'))
  const home = join(root, 'home')
  const bin = process.execPath
  mkdirSync(join(home, '.boo'), { recursive: true })
  writeFileSync(join(home, '.boo', 'computer.json'), JSON.stringify({ version: 1, bridges: {
    linux: { command: bin, args: [fixtureBridge] },
    darwin: { command: bin, args: [fixtureBridge] },
    win32: { command: bin, args: [fixtureBridge] },
  } }))
  return { home, bin }
}

test('konfigurasi computer use memilih bridge OS dan menolak command relatif', () => {
  const { home, bin } = fixture()
  assert.deepEqual(loadComputerBridge(home, 'linux'), { command: bin, args: [fixtureBridge], platform: 'linux' })
  writeFileSync(join(home, '.boo', 'computer.json'), JSON.stringify({ version: 1, bridges: { linux: { command: 'bridge' } } }))
  assert.equal(loadComputerBridge(home, 'linux'), null)
})

test('bridge computer memakai protokol JSON dan menyaring elemen tidak sah', async () => {
  const { home } = fixture()
  const bridge = loadComputerBridge(home, process.platform)
  assert.ok(bridge)
  const response = await callComputerBridge(bridge, { version: 1, action: 'snapshot', maxElements: 20 })
  assert.equal(response.app, 'Editor')
  assert.deepEqual(response.elements, [{ ref: 'e1', role: 'button', name: 'Save', enabled: true }])
})

test('tool computer snapshot dan type meneruskan ref aman tanpa shell', async () => {
  const { home } = fixture()
  const snapshot = await computerSnapshotTool.run({ max_elements: 20 }, { workspace: tmpdir(), home })
  assert.equal(snapshot.isError, false)
  assert.match(snapshot.content, /e1 · button · Save/)
  const typed = await computerTypeTool.run({ ref: 'e1', text: 'halo' }, { workspace: tmpdir(), home })
  assert.match(typed.content, /type:e1:halo/)
  const invalid = await computerTypeTool.run({ ref: '../x', text: 'halo' }, { workspace: tmpdir(), home })
  assert.equal(invalid.isError, true)
  const secret = await computerTypeTool.run({ ref: 'e1', text: 'Authorization: Bearer sangat-rahasia' }, { workspace: tmpdir(), home })
  assert.equal(secret.isError, true)
})
