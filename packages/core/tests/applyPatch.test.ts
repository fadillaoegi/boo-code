import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Checkpoints } from '../src/agent/checkpoints.ts'
import { applyPatchTool, parsePatch } from '../src/tools/applyPatch.ts'
import { FileSnapshots } from '../src/tools/fileSnapshots.ts'

const patch = (...lines: string[]) => ['*** Begin Patch', ...lines, '*** End Patch'].join('\n')

test('parser mengenali update, add, dan delete dalam satu dokumen', () => {
  const operations = parsePatch(patch(
    '*** Update File: a.txt', '@@', '-lama', '+baru',
    '*** Add File: b.txt', '+isi', '+',
    '*** Delete File: c.txt',
  ))
  assert.deepEqual(operations.map(({ kind, path }) => [kind, path]), [
    ['update', 'a.txt'], ['add', 'b.txt'], ['delete', 'c.txt'],
  ])
  assert.equal(operations[1].content, 'isi\n')
})

test('multi-file patch diterapkan dan dapat di-undo sebagai satu checkpoint', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'boo-patch-'))
  await writeFile(join(workspace, 'a.txt'), 'alpha\nbeta\n')
  await writeFile(join(workspace, 'old.txt'), 'hapus\n')
  const checkpoints = new Checkpoints(workspace)
  checkpoints.begin('ubah tiga file')
  const result = await applyPatchTool.run({ patch: patch(
    '*** Update File: a.txt', '@@', '-alpha', '+ALPHA', ' beta',
    '*** Add File: nested/b.txt', '+baru', '+',
    '*** Delete File: old.txt',
  ) }, { workspace, checkpoint: checkpoints })

  assert.equal(result.isError, undefined)
  assert.equal(await readFile(join(workspace, 'a.txt'), 'utf8'), 'ALPHA\nbeta\n')
  assert.equal(await readFile(join(workspace, 'nested/b.txt'), 'utf8'), 'baru\n')
  assert.equal(existsSync(join(workspace, 'old.txt')), false)

  const plan = await checkpoints.undo()
  assert.deepEqual(plan?.entries.map((entry) => [entry.label, entry.action]), [
    ['a.txt', 'restore'], ['nested/b.txt', 'delete'], ['old.txt', 'restore'],
  ])
  assert.equal(await readFile(join(workspace, 'a.txt'), 'utf8'), 'alpha\nbeta\n')
  assert.equal(await readFile(join(workspace, 'old.txt'), 'utf8'), 'hapus\n')
  assert.equal(existsSync(join(workspace, 'nested/b.txt')), false)
})

test('seluruh patch ditolak sebelum menulis bila satu hunk invalid', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'boo-patch-invalid-'))
  await writeFile(join(workspace, 'a.txt'), 'satu\n')
  await writeFile(join(workspace, 'b.txt'), 'dua\n')
  const result = await applyPatchTool.run({ patch: patch(
    '*** Update File: a.txt', '@@', '-satu', '+SATU',
    '*** Update File: b.txt', '@@', '-tidak ada', '+DUA',
  ) }, { workspace })
  assert.equal(result.isError, true)
  assert.equal(await readFile(join(workspace, 'a.txt'), 'utf8'), 'satu\n')
  assert.equal(await readFile(join(workspace, 'b.txt'), 'utf8'), 'dua\n')
})

test('patch stale ditolak bila file berubah setelah preview approval', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'boo-patch-stale-'))
  const target = join(workspace, 'a.txt')
  await writeFile(target, 'awal\n')
  const fileSnapshots = new FileSnapshots()
  const args = { patch: patch('*** Update File: a.txt', '@@', '-awal', '+dari Boo') }
  const context = { workspace, fileSnapshots }
  await applyPatchTool.detail?.(args, context)
  await writeFile(target, 'dari pengguna\n')
  const result = await applyPatchTool.run(args, context)
  assert.equal(result.isError, true)
  assert.match(result.content, /berubah sejak terakhir dibaca/)
  assert.equal(await readFile(target, 'utf8'), 'dari pengguna\n')
})

test('konteks ambigu ditolak agar model menambahkan konteks unik', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'boo-patch-ambiguous-'))
  await writeFile(join(workspace, 'a.txt'), 'sama\ntengah\nsama\n')
  const result = await applyPatchTool.run({ patch: patch(
    '*** Update File: a.txt', '@@', '-sama', '+beda',
  ) }, { workspace })
  assert.equal(result.isError, true)
  assert.match(result.content, /lebih dari sekali/)
})
