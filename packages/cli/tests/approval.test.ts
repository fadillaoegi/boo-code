import assert from 'node:assert/strict'
import test from 'node:test'
import { condense, diffLines } from '@boo/core'
import { commandBody, describeRequest, diffBody, languageOf, renderPanel } from '../src/approval.ts'
import { stripAnsi, visibleWidth } from '../src/text.ts'

const ESC = String.fromCharCode(27)

function plainLines(lines: string[]): string[] {
  return lines.map((line) => stripAnsi(line))
}

test('tindakan disebut dengan bahasa manusia sesuai tool dan keberadaan berkas', () => {
  assert.equal(describeRequest('write_file', { path: 'a.md' }, false).title, 'Buat berkas')
  assert.equal(describeRequest('write_file', { path: 'a.md' }, false).question, 'Buat a.md?')
  assert.equal(describeRequest('write_file', { path: 'a.md' }, true).title, 'Tulis ulang berkas')
  assert.equal(describeRequest('edit_file', { path: 'b.ts' }, true).title, 'Ubah berkas')
  assert.equal(describeRequest('bash', { command: 'ls' }, false).title, 'Jalankan perintah')
  assert.equal(describeRequest('write_file', { path: 'a.md' }, false).kind, 'edit')
  assert.equal(describeRequest('bash', { command: 'ls' }, false).kind, 'command')
})

test('bahasa syntax highlighting diturunkan dari ekstensi berkas', () => {
  assert.equal(languageOf('src/app.tsx'), 'tsx')
  assert.equal(languageOf('skrip.PY'), 'python')
  assert.equal(languageOf('catatan.md'), '')
})

test('setiap baris panel sama lebarnya, termasuk yang berisi emoji', () => {
  const request = describeRequest('write_file', { path: 'catatan 🎉.md' }, false)
  const detail = diffLines('', '# Judul ✅\nbaris kedua yang cukup panjang untuk melewati lebar panel yang sempit ini\n')
  const width = 50
  const panel = renderPanel(request, diffBody(detail, 'catatan.md', width - 4, 20), width, { added: 3, removed: 0 })
  const widths = new Set(plainLines(panel).map((line) => visibleWidth(line)))
  assert.deepEqual([...widths], [width + 2], 'lebar panel ditambah indentasi')
})

test('diff menampilkan nomor baris dan penanda tambah serta hapus', () => {
  const detail = condense(diffLines('satu\ndua\ntiga', 'satu\nDUA\ntiga'))
  const rows = diffBody(detail, 'a.txt', 40, 20).map((row) => row.map((run) => run.text).join(''))
  assert.ok(rows.some((row) => /^2 - dua/.test(row)), `baris dihapus bernomor: ${rows.join(' | ')}`)
  assert.ok(rows.some((row) => /^2 \+ DUA/.test(row)), 'baris ditambah bernomor')
})

test('baris yang berubah diberi latar selebar panel', () => {
  const detail = diffLines('', 'pendek\n')
  const [row] = diffBody(detail, 'a.txt', 30, 20)
  assert.equal(visibleWidth(row.map((run) => run.text).join('')), 30)
  assert.ok(row.every((run) => run.style.background), 'seluruh baris berlatar')
})

test('diff yang panjang dipotong dengan keterangan sisanya', () => {
  const detail = diffLines('', `${Array.from({ length: 60 }, (_, i) => `baris ${i}`).join('\n')}\n`)
  const rows = diffBody(detail, 'a.txt', 40, 10)
  assert.equal(rows.length, 10)
  assert.match(rows.at(-1)!.map((run) => run.text).join(''), /baris diff lagi/)
})

test('perintah panjang tidak pernah dipotong, hanya dibungkus', () => {
  const command = 'git log --oneline --graph --decorate --all -n 50 && rm -rf ./build-sementara-yang-sangat-panjang'
  const rows = commandBody(command, 30)
  const joined = rows.map((row) => row.map((run) => run.text).join('')).join('')
  assert.equal(joined.replace(/^\$ /, '').replace(/ {2}/g, ''), command.replace(/ {2}/g, ''))
  assert.ok(rows.length > 2)
  for (const row of rows) assert.ok(visibleWidth(row.map((run) => run.text).join('')) <= 30)
})

test('nama berkas yang terlalu panjang dipotong dari depan agar ujungnya terlihat', () => {
  const request = describeRequest('edit_file', { path: 'folder/yang/sangat/dalam/sekali/berkas-penting.ts' }, true)
  const panel = plainLines(renderPanel(request, [], 36))
  assert.ok(panel.some((line) => line.includes('berkas-penting.ts')), panel.join('\n'))
})

test('panel diakhiri reset agar gaya tidak bocor', () => {
  const request = describeRequest('bash', { command: 'ls' }, false)
  for (const line of renderPanel(request, commandBody('ls', 40), 44)) {
    if (line.includes(`${ESC}[`)) assert.ok(line.endsWith(`${ESC}[0m`))
  }
})

test('panel undo: aksi per berkas, peringatan perubahan pengguna dan perintah bash', async () => {
  const { undoBody } = await import('../src/approval.ts')
  const rows = undoBody({
    checkpointId: 1,
    prompt: 'x',
    ranCommands: true,
    entries: [
      { label: 'src/app.ts', action: 'restore', modifiedSince: true, added: 1, removed: 3 },
      { label: 'baru.ts', action: 'delete', modifiedSince: false, added: 0, removed: 12 },
    ],
  }).map((row) => row.map((run) => run.text).join(''))
  assert.match(rows[0], /^↺ kembalikan {2}src\/app\.ts {2}\+1 -3$/)
  assert.match(rows[1], /diubah lagi setelah Boo/)
  assert.match(rows[2], /^✗ hapus {7}baru\.ts {5}\+0 -12$/)
  assert.match(rows.at(-1)!, /bash .*tidak ikut dibatalkan/)
})
