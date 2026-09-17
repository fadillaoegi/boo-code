import assert from 'node:assert/strict'
import test from 'node:test'
import { countLines, describeArgs, lastOutputLine, ToolCallProgress, toolActivity, turnActivity } from '../src/presentation/activity.ts'

/** Mengalirkan argumen JSON potong demi potong, seperti dari provider. */
function stream(name: string, args: object, size: number): ToolCallProgress {
  const progress = new ToolCallProgress(name)
  const json = JSON.stringify(args)
  for (let index = 0; index < json.length; index += size) progress.add(json.slice(index, index + size))
  return progress
}

test('setiap tool dipetakan ke aktivitas yang sesungguhnya', () => {
  assert.equal(toolActivity('list_dir'), 'Searching')
  assert.equal(toolActivity('read_file'), 'Reading')
  assert.equal(toolActivity('write_file'), 'Writing')
  assert.equal(toolActivity('edit_file'), 'Implementing')
  assert.equal(toolActivity('bash'), 'Running')
})

test('putaran awal berpikir, putaran setelah tool mengorkestrasi', () => {
  assert.equal(turnActivity(0), 'Thinking')
  assert.equal(turnActivity(1), 'Orchestrating')
  assert.equal(turnActivity(5), 'Orchestrating')
})

test('path ditemukan walau terbelah di antara potongan', () => {
  const progress = stream('write_file', { path: 'src/komponen/tombol.tsx', content: 'a' }, 3)
  assert.equal(progress.path, 'src/komponen/tombol.tsx')
})

test('path dengan karakter ter-escape dipulihkan', () => {
  const progress = stream('read_file', { path: 'folder "khusus"/berkas.ts' }, 2)
  assert.equal(progress.path, 'folder "khusus"/berkas.ts')
})

test('baris isi dihitung walau penanda baris baru terbelah di antara potongan', () => {
  const content = `${Array.from({ length: 42 }, (_, i) => `baris ${i}`).join('\n')}\n`
  for (const size of [1, 2, 5, 17, 1000]) {
    const progress = stream('write_file', { path: 'a.ts', content }, size)
    assert.equal(progress.lines, 42, `potongan ${size} karakter`)
  }
})

test('garis miring terbalik literal tidak dihitung sebagai baris baru', () => {
  const progress = stream('write_file', { path: 'a.ts', content: 'C:\\new\\name' }, 1)
  assert.equal(progress.lines, 0)
})

test('keterangan write_file memuat jumlah baris, tool lain cukup path', () => {
  assert.equal(stream('write_file', { path: 'a.ts', content: 'x\ny\n' }, 4).describe(), 'a.ts · 2 lines')
  assert.equal(stream('write_file', { path: 'a.ts', content: 'x\n' }, 4).describe(), 'a.ts · 1 line')
  // Sebelum satu baris pun selesai, cukup path.
  assert.equal(stream('write_file', { path: 'a.ts', content: 'x' }, 4).describe(), 'a.ts')
  assert.equal(stream('edit_file', { path: 'b.ts', old_text: 'a\nb', new_text: 'c' }, 4).describe(), 'b.ts')
})

test('belum ada keterangan sebelum path diketahui', () => {
  const progress = new ToolCallProgress('write_file')
  progress.add('{"pa')
  assert.equal(progress.describe(), '')
})

test('keterangan dari argumen utuh sama bentuknya dengan saat mengalir', () => {
  // Berkas diakhiri baris baru: hitungan saat mengalir berakhir sama dengan hitungan final.
  const args = { path: 'a.ts', content: 'x\ny\nz\n' }
  assert.equal(describeArgs('write_file', args), stream('write_file', args, 3).describe())
  assert.equal(describeArgs('read_file', { path: 'src/app.ts' }), 'src/app.ts')
  assert.equal(describeArgs('list_dir', {}), '.')
  assert.equal(describeArgs('bash', { command: 'pnpm test' }), 'pnpm test')
})

test('baris baru di akhir berkas tidak menambah hitungan baris', () => {
  const thirty = `${Array.from({ length: 30 }, (_, i) => `${i + 1}. poin`).join('\n')}\n`
  assert.equal(countLines(thirty), 30)
  assert.equal(countLines('a\nb'), 2)
  assert.equal(countLines('satu'), 1)
  assert.equal(countLines(''), 0)
  assert.equal(describeArgs('write_file', { path: 'ringkasan.md', content: thirty }), 'ringkasan.md · 30 lines')
})

test('pencarian ditampilkan sebagai Searching dengan polanya', () => {
  assert.equal(toolActivity('grep'), 'Searching')
  assert.equal(toolActivity('glob'), 'Searching')
  assert.equal(describeArgs('grep', { pattern: 'useChat', path: 'src' }), '"useChat" in src')
  assert.equal(describeArgs('glob', { pattern: '**/*.ts' }), '**/*.ts')
})

test('baris terakhir keluaran: warna dan bilah progres dibersihkan, baris kosong dilewati', () => {
  const ESC = String.fromCharCode(27)
  assert.equal(lastOutputLine('langkah 1\nlangkah 2\n\n'), 'langkah 2')
  assert.equal(lastOutputLine(`${ESC}[32m✓${ESC}[0m lulus\n`), '✓ lulus')
  assert.equal(lastOutputLine('unduh 10%\runduh 55%\runduh 90%'), 'unduh 90%')
  assert.equal(lastOutputLine(''), '')
})

test('argumen perintah latar belakang dan pemeriksaannya', () => {
  assert.equal(describeArgs('bash', { command: 'pnpm dev', run_in_background: true }), 'pnpm dev · background')
  assert.equal(describeArgs('bash_output', { id: 'bg1' }), 'bg1')
})
