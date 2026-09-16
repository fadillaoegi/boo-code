import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { condense, diffLines, diffStats } from '../src/tools/diff.ts'
import { writeFileTool } from '../src/tools/writeFile.ts'
import { editFileTool } from '../src/tools/editFile.ts'

test('baris yang tidak berubah ditandai sebagai konteks', () => {
  const lines = diffLines('a\nb\nc', 'a\nb\nc')
  assert.ok(lines.every((line) => line.kind === 'context'))
  assert.deepEqual(diffStats(lines), { added: 0, removed: 0 })
})

test('satu baris yang diubah menjadi sepasang hapus dan tambah', () => {
  const lines = diffLines('a\nb\nc', 'a\nB\nc')
  assert.deepEqual(diffStats(lines), { added: 1, removed: 1 })
  assert.ok(lines.some((line) => line.kind === 'remove' && line.text === 'b'))
  assert.ok(lines.some((line) => line.kind === 'add' && line.text === 'B'))
})

test('penyisipan tidak menghapus baris yang sudah ada', () => {
  const lines = diffLines('a\nc', 'a\nb\nc')
  assert.deepEqual(diffStats(lines), { added: 1, removed: 0 })
})

test('penghapusan tidak menambah baris', () => {
  const lines = diffLines('a\nb\nc', 'a\nc')
  assert.deepEqual(diffStats(lines), { added: 0, removed: 1 })
})

test('file baru tampil seluruhnya sebagai tambahan', () => {
  const lines = diffLines('', 'satu\ndua')
  assert.deepEqual(diffStats(lines), { added: 2, removed: 0 })
})

test('konteks yang jauh dari perubahan diringkas', () => {
  const before = Array.from({ length: 60 }, (_, i) => `baris ${i}`).join('\n')
  const after = before.replace('baris 30', 'baris 30 diubah')

  const full = diffLines(before, after)
  const short = condense(full)

  assert.ok(short.length < full.length, 'hasil ringkas harus lebih pendek')
  assert.deepEqual(diffStats(short), diffStats(full), 'perubahan tidak boleh hilang saat diringkas')
  assert.ok(short.some((line) => line.text.includes('tidak berubah')))
})

test('write_file memberi pratinjau diff terhadap isi lama', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'boo-diff-'))
  await writeFile(join(workspace, 'a.txt'), 'satu\ndua\n', 'utf8')

  const detail = await writeFileTool.detail!({ path: 'a.txt', content: 'satu\nDUA\n' }, { workspace })

  assert.ok(detail)
  assert.deepEqual(diffStats(detail), { added: 1, removed: 1 })
})

test('write_file tanpa perubahan tidak menampilkan diff', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'boo-diff-'))
  await writeFile(join(workspace, 'a.txt'), 'sama\n', 'utf8')

  const detail = await writeFileTool.detail!({ path: 'a.txt', content: 'sama\n' }, { workspace })

  assert.equal(detail, null)
})

test('write_file pada file baru menampilkan seluruh isi sebagai tambahan', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'boo-diff-'))

  const detail = await writeFileTool.detail!({ path: 'baru.txt', content: 'a\nb\nc' }, { workspace })

  assert.ok(detail)
  assert.deepEqual(diffStats(detail), { added: 3, removed: 0 })
})

test('edit_file memberi pratinjau sebelum berkas disentuh', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'boo-diff-'))
  await writeFile(join(workspace, 'a.txt'), 'halo dunia\n', 'utf8')

  const detail = await editFileTool.detail!(
    { path: 'a.txt', old_text: 'halo dunia', new_text: 'halo Boo' },
    { workspace },
  )

  assert.ok(detail)
  assert.deepEqual(diffStats(detail), { added: 1, removed: 1 })
  // Berkasnya belum boleh berubah hanya karena pratinjau dibuat.
  const { readFile } = await import('node:fs/promises')
  assert.equal(await readFile(join(workspace, 'a.txt'), 'utf8'), 'halo dunia\n')
})
