import assert from 'node:assert/strict'
import test from 'node:test'
import { MarkdownRenderer, parseInline, wrapRuns } from '../src/markdown.ts'
import { stripAnsi, visibleWidth } from '../src/text.ts'

const ESC = String.fromCharCode(27)

function render(markdown: string, width = 60): string {
  const renderer = new MarkdownRenderer({ width })
  return renderer.push(markdown) + renderer.end()
}

function plain(markdown: string, width = 60): string[] {
  // Render selalu diakhiri baris baru; elemen kosong terakhir dari split dibuang.
  return stripAnsi(render(markdown, width)).split('\n').slice(0, -1)
}

function styleOf(markdown: string, fragment: string): string {
  const runs = parseInline(markdown)
  const run = runs.find((item) => item.text.includes(fragment))
  assert.ok(run, `potongan "${fragment}" tidak ditemukan`)
  return JSON.stringify(run.style)
}

test('streaming per karakter menghasilkan render yang sama dengan sekaligus', () => {
  const answer = [
    '# Judul',
    '',
    'Teks **tebal** dan *miring* dengan `kode` serta [tautan](https://boo.dev).',
    '',
    '- butir satu yang cukup panjang sehingga harus dibungkus ke baris berikutnya',
    '  - butir bersarang',
    '1. langkah pertama',
    '',
    '```ts',
    'const nama = "Boo" // komentar',
    '```',
    '',
    '| Kolom | Nilai |',
    '|---|---:|',
    '| a | 1 |',
    '> kutipan',
    'akhir tanpa baris baru',
  ].join('\n')

  const whole = render(answer)
  const renderer = new MarkdownRenderer({ width: 60 })
  let streamed = ''
  for (const character of answer) streamed += renderer.push(character)
  streamed += renderer.end()
  assert.equal(streamed, whole)
})

test('baris baru ditampilkan hanya setelah lengkap', () => {
  const renderer = new MarkdownRenderer({ width: 60 })
  assert.equal(renderer.push('**teb'), '')
  assert.equal(renderer.hasPending, true)
  const output = renderer.push('al**\n')
  assert.equal(stripAnsi(output), '  tebal\n')
  assert.equal(renderer.hasPending, false)
})

test('tebal, miring, coret, dan kode diberi gaya tanpa penandanya', () => {
  assert.deepEqual(plain('**tebal** *miring* ~~coret~~ `kode`'), ['  tebal miring coret kode'])
  assert.match(styleOf('**tebal**', 'tebal'), /"bold":true/)
  assert.match(styleOf('*miring*', 'miring'), /"italic":true/)
  assert.match(styleOf('~~coret~~', 'coret'), /"strike":true/)
  assert.match(styleOf('`kode`', 'kode'), /"color"/)
})

test('penanda yang bukan penekanan tampil apa adanya', () => {
  assert.deepEqual(plain('2 * 3 * 4 = 24'), ['  2 * 3 * 4 = 24'])
  assert.deepEqual(plain('nama_variabel_ini dan __init__'), ['  nama_variabel_ini dan init'])
  assert.deepEqual(plain('**tidak pernah ditutup'), ['  **tidak pernah ditutup'])
  assert.deepEqual(plain('harga \\*diskon\\*'), ['  harga *diskon*'])
})

test('isi code span tidak diproses sebagai markdown', () => {
  assert.deepEqual(plain('pakai `**bukan tebal**` ya'), ['  pakai **bukan tebal** ya'])
})

test('penekanan bersarang tetap utuh', () => {
  const runs = parseInline('**tebal *dan miring* lagi**')
  assert.equal(runs.map((run) => run.text).join(''), 'tebal dan miring lagi')
  const nested = runs.find((run) => run.text === 'dan miring')
  assert.ok(nested?.style.bold && nested.style.italic)
})

test('tautan menampilkan label dan alamatnya', () => {
  assert.deepEqual(plain('lihat [dokumentasi](https://boo.dev/docs)'), ['  lihat dokumentasi (https://boo.dev/docs)'])
  assert.deepEqual(plain('buka https://boo.dev.'), ['  buka https://boo.dev.'])
  assert.match(styleOf('buka https://boo.dev', 'https'), /"underline":true/)
})

test('judul tanpa tanda pagar, dipisah baris kosong dari teks sebelumnya', () => {
  assert.deepEqual(plain('pembuka\n## Bagian Dua'), ['  pembuka', '', '  Bagian Dua'])
})

test('daftar memakai penanda rapi dan indentasi gantung saat dibungkus', () => {
  const lines = plain('- satu dua tiga empat lima enam tujuh delapan sembilan', 24)
  assert.equal(lines[0].startsWith('  • satu'), true)
  for (const line of lines.slice(1)) assert.ok(line.startsWith('    '), `lanjutan harus sejajar isi: "${line}"`)
})

test('daftar bersarang, bernomor, dan tugas', () => {
  const lines = plain('- induk\n  - anak\n    - cucu\n1. pertama\n- [ ] belum\n- [x] sudah')
  assert.deepEqual(lines, ['  • induk', '    ◦ anak', '      ▪ cucu', '  1. pertama', '  ☐ belum', '  ☑ sudah'])
})

test('tidak ada baris yang melewati lebar, termasuk yang memuat emoji', () => {
  const text = 'Kalimat panjang 🎉 dengan emoji ✅ dan kata-kata yang terus berlanjut sampai jauh melewati tepi layar terminal.'
  for (const line of plain(text, 30)) assert.ok(visibleWidth(line) <= 30, `terlalu lebar: "${line}"`)
})

test('kata yang lebih panjang dari baris dipotong paksa', () => {
  const lines = wrapRuns([{ text: 'x'.repeat(50), style: {} }], 20, [], [])
  assert.ok(lines.length >= 3)
  for (const line of lines) assert.ok(visibleWidth(line.map((run) => run.text).join('')) <= 20)
})

test('blok kode diberi label bahasa dan garis tepi tanpa diproses markdown', () => {
  const lines = plain('```python\ndef f(): return **x**\n```')
  assert.deepEqual(lines, ['  python', '  │ def f(): return **x**'])
})

test('blok kode diwarnai sesuai bahasanya', () => {
  const output = render('```ts\nconst x = 1\n```')
  assert.ok(output.includes(`${ESC}[`), 'harus memuat kode warna')
})

test('baris kode panjang dibungkus dengan garis tepi tetap ada', () => {
  const lines = plain(`\`\`\`\n${'a'.repeat(90)}\n\`\`\``, 40)
  assert.ok(lines.length >= 3)
  for (const line of lines) {
    assert.ok(line.startsWith('  │ '))
    assert.ok(visibleWidth(line) <= 40)
  }
})

test('tabel digambar dengan bingkai dan kolom sejajar', () => {
  const lines = plain('| Nama | Nilai |\n|:---|---:|\n| Boo | 1 |\n| Panjang | 1000 |')
  assert.deepEqual(lines, [
    '  ┌─────────┬───────┐',
    '  │ Nama    │ Nilai │',
    '  ├─────────┼───────┤',
    '  │ Boo     │     1 │',
    '  │ Panjang │  1000 │',
    '  └─────────┴───────┘',
  ])
})

test('tabel yang terlalu lebar dibungkus di dalam kolomnya', () => {
  const long = 'isi sel yang sangat panjang sekali dan tidak mungkin muat dalam satu baris'
  const lines = plain(`| A | B |\n|---|---|\n| ${long} | ${long} |`, 50)
  for (const line of lines) assert.ok(visibleWidth(line) <= 50, `terlalu lebar: "${line}"`)
  assert.ok(lines.length > 6, 'isi harus dibungkus menjadi beberapa baris')
})

test('baris yang terbungkus dipisah garis agar batas antarbaris jelas', () => {
  const lines = plain('| A | B |\n|---|---|\n| satu | isi yang cukup panjang untuk dibungkus |\n| dua | pendek |', 32)
  const separators = lines.filter((line) => line.includes('┼'))
  assert.equal(separators.length, 2, 'satu di bawah header, satu di antara dua baris isi')
})

test('tabel ringkas tidak diberi pemisah antarbaris', () => {
  const lines = plain('| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |')
  assert.equal(lines.filter((line) => line.includes('┼')).length, 1)
})

test('tabel berisi emoji tetap sejajar karena emoji dihitung dua kolom', () => {
  const lines = plain('| Hasil | Catatan |\n|---|---|\n| ✅ lolos | aman |\n| ❌ gagal | 🎉 x |')
  const widths = new Set(lines.map((line) => visibleWidth(line)))
  assert.equal(widths.size, 1, `lebar baris berbeda: ${[...widths].join(', ')}`)
})

test('baris berawalan | tanpa baris pemisah tampil sebagai teks biasa', () => {
  assert.deepEqual(plain('| bukan tabel |'), ['  | bukan tabel |'])
})

test('kutipan diberi garis tepi', () => {
  assert.deepEqual(plain('> catatan penting'), ['  │ catatan penting'])
})

test('baris kosong beruntun diringkas dan baris kosong awal dibuang', () => {
  assert.deepEqual(plain('\n\n\nsatu\n\n\n\ndua'), ['  satu', '', '  dua'])
})

test('setiap baris diakhiri reset agar gaya tidak bocor ke prompt', () => {
  for (const line of render('**tebal** dan `kode`').split('\n').filter(Boolean)) {
    if (line.includes(`${ESC}[`)) assert.ok(line.endsWith(`${ESC}[0m`), 'baris bergaya harus diakhiri reset')
  }
})
