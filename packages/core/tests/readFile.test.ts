import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_CHARACTERS, readFileTool } from '../src/tools/readFile.ts'

const workspace = mkdtempSync(join(tmpdir(), 'boo-baca-'))
const read = (args: Record<string, unknown>) => readFileTool.run(args as never, { workspace })

writeFileSync(join(workspace, 'kecil.txt'), 'satu\ndua\ntiga\n')
writeFileSync(join(workspace, 'besar.txt'), Array.from({ length: 5_000 }, (_, i) => `baris ke-${i + 1}`).join('\n'))

test('berkas kecil dibaca utuh dengan nomor baris, tanpa catatan', async () => {
  const { content } = await read({ path: 'kecil.txt' })
  assert.equal(content, '    1\tsatu\n    2\tdua\n    3\ttiga')
})

test('berkas besar: bagian pertama beserta petunjuk melanjutkan', async () => {
  const { content } = await read({ path: 'besar.txt' })
  assert.match(content, /^ {4}1\tbaris ke-1\n/)
  assert.match(content, / 2000\tbaris ke-2000\n/)
  assert.doesNotMatch(content, /baris ke-2001\b/)
  assert.match(content, /Baris 1–2000 dari 5000\. Lanjutkan dengan offset 2001/)
})

test('offset dan limit membaca bagian tertentu dengan nomor baris aslinya', async () => {
  const { content } = await read({ path: 'besar.txt', offset: 4_998, limit: 10 })
  assert.equal(content, ' 4998\tbaris ke-4998\n 4999\tbaris ke-4999\n 5000\tbaris ke-5000\n\n[Baris 4998–5000 dari 5000; akhir berkas.]')
  const middle = await read({ path: 'besar.txt', offset: 100, limit: 2 })
  assert.match(middle.content, /^ {2}100\tbaris ke-100\n {2}101\tbaris ke-101\n\n\[Baris 100–101 dari 5000\. Lanjutkan dengan offset 102/)
})

test('offset melewati akhir berkas ditolak dengan jelas', async () => {
  const result = await read({ path: 'kecil.txt', offset: 50 })
  assert.equal(result.isError, true)
  assert.match(result.content, /hanya 3 baris/)
})

test('batas karakter tetap berlaku, dan pembacaan berikutnya tetap maju', async () => {
  writeFileSync(join(workspace, 'lebar.txt'), Array.from({ length: 100 }, () => 'x'.repeat(1_500)).join('\n'))
  const { content } = await read({ path: 'lebar.txt' })
  assert.ok(content.length < MAX_CHARACTERS + 500)
  const next = Number(/offset (\d+)/.exec(content)?.[1])
  assert.ok(next > 1 && next < 100)
})

test('baris hasil minify dipotong, berkas biner ditolak', async () => {
  writeFileSync(join(workspace, 'app.min.js'), `var a=1;${'x'.repeat(500_000)}`)
  const minified = await read({ path: 'app.min.js' })
  assert.ok(minified.content.length < 5_000)
  assert.match(minified.content, /baris dipotong, 500008 karakter[\s\S]*1 baris yang sangat panjang dipotong/)

  writeFileSync(join(workspace, 'gambar.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))
  const binary = await read({ path: 'gambar.png' })
  assert.equal(binary.isError, true)
  assert.match(binary.content, /biner/)
})

test('berkas kosong', async () => {
  writeFileSync(join(workspace, 'kosong.txt'), '')
  assert.equal((await read({ path: 'kosong.txt' })).content, '(berkas kosong)')
})
