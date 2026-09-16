import assert from 'node:assert/strict'
import test from 'node:test'
import { editFileTool } from '../src/tools/editFile.ts'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function sandbox(content: string) {
  const workspace = await mkdtemp(join(tmpdir(), 'boo-test-'))
  await writeFile(join(workspace, 'a.txt'), content, 'utf8')
  return workspace
}

test('edit_file mengganti cuplikan yang unik', async () => {
  const workspace = await sandbox('satu\ndua\ntiga\n')
  const result = await editFileTool.run(
    { path: 'a.txt', old_text: 'dua', new_text: 'DUA' },
    { workspace },
  )
  assert.equal(result.isError, undefined)
  assert.equal(await readFile(join(workspace, 'a.txt'), 'utf8'), 'satu\nDUA\ntiga\n')
})

test('edit_file menolak cuplikan ambigu tanpa mengubah file', async () => {
  const workspace = await sandbox('x\nx\n')
  const result = await editFileTool.run(
    { path: 'a.txt', old_text: 'x', new_text: 'y' },
    { workspace },
  )
  assert.equal(result.isError, true)
  assert.match(result.content, /muncul 2 kali/)
  assert.equal(await readFile(join(workspace, 'a.txt'), 'utf8'), 'x\nx\n')
})

test('edit_file melaporkan cuplikan yang tidak ada sebagai hasil, bukan exception', async () => {
  const workspace = await sandbox('halo\n')
  const result = await editFileTool.run(
    { path: 'a.txt', old_text: 'tidak ada', new_text: 'z' },
    { workspace },
  )
  assert.equal(result.isError, true)
  assert.match(result.content, /tidak ditemukan/)
})
