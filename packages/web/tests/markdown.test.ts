import assert from 'node:assert/strict'
import test from 'node:test'
import { parseInline, parseMarkdown, safeHref } from '../src/client/markdown.ts'

test('blok dasar: judul, paragraf dengan baris baru, garis, kutipan', () => {
  assert.deepEqual(parseMarkdown('# Judul\n\nbaris satu\nbaris dua\n\n---\n\n> kutip **tebal**'), [
    { type: 'heading', level: 1, inlines: [{ type: 'text', text: 'Judul' }] },
    { type: 'paragraph', inlines: [{ type: 'text', text: 'baris satu' }, { type: 'break' }, { type: 'text', text: 'baris dua' }] },
    { type: 'rule' },
    { type: 'quote', blocks: [{ type: 'paragraph', inlines: [{ type: 'text', text: 'kutip ' }, { type: 'strong', children: [{ type: 'text', text: 'tebal' }] }] }] },
  ])
})

test('blok kode: bahasa dikenali, isinya tidak diparse, yang belum ditutup berlanjut', () => {
  assert.deepEqual(parseMarkdown('```ts\nconst a = **1**\n```\nsesudah'), [
    { type: 'code', language: 'ts', text: 'const a = **1**', closed: true },
    { type: 'paragraph', inlines: [{ type: 'text', text: 'sesudah' }] },
  ])
  assert.deepEqual(parseMarkdown('mulai\n```js\nlet x'), [
    { type: 'paragraph', inlines: [{ type: 'text', text: 'mulai' }] },
    { type: 'code', language: 'js', text: 'let x', closed: false },
  ])
})

test('daftar bertingkat, bernomor, dan checklist', () => {
  const [list] = parseMarkdown('1. satu\n   - anak\n2. dua\n\n3. tiga')
  assert.equal(list.type, 'list')
  if (list.type !== 'list') return
  assert.equal(list.ordered, true)
  assert.equal(list.items.length, 3, 'baris kosong di antara butir tidak memutus daftar')
  assert.equal(list.items[0].blocks[1].type, 'list')

  const [tasks] = parseMarkdown('- [x] selesai\n- [ ] belum')
  assert.ok(tasks.type === 'list' && tasks.items.map((item) => item.checked).join() === 'true,false')
})

test('tabel dengan perataan dan pipa di dalam kode', () => {
  const [table] = parseMarkdown('| Nama | Nilai |\n|:--|--:|\n| `a|b` | 2 |')
  assert.ok(table.type === 'table')
  if (table.type !== 'table') return
  assert.deepEqual(table.align, ['left', 'right'])
  assert.deepEqual(table.rows[0][0], [{ type: 'code', text: 'a|b' }])
})

test('HTML dan tautan berbahaya tidak pernah menjadi elemen', () => {
  assert.deepEqual(parseInline('<script>alert(1)</script>'), [{ type: 'text', text: '<script>alert(1)</script>' }])
  assert.deepEqual(parseInline('[klik](javascript:alert(1))'), [{ type: 'text', text: 'klik' }])
  assert.equal(safeHref('JAVASCRIPT:alert(1)'), null)
  assert.equal(safeHref('data:text/html,x'), null)
  assert.equal(safeHref('https://boo.dev'), 'https://boo.dev')
  assert.deepEqual(parseInline('lihat https://boo.dev/docs.'), [
    { type: 'text', text: 'lihat ' },
    { type: 'link', href: 'https://boo.dev/docs', children: [{ type: 'text', text: 'https://boo.dev/docs' }] },
    { type: 'text', text: '.' },
  ])
})

test('penanda inline: nama_variabel tidak miring, bintang tak berpasangan tampil apa adanya', () => {
  assert.deepEqual(parseInline('pakai nama_variabel_ini'), [{ type: 'text', text: 'pakai nama_variabel_ini' }])
  assert.deepEqual(parseInline('2 * 3 = 6'), [{ type: 'text', text: '2 * 3 = 6' }])
  assert.deepEqual(parseInline('**a** dan *b* dan ~~c~~ dan `**d**`'), [
    { type: 'strong', children: [{ type: 'text', text: 'a' }] },
    { type: 'text', text: ' dan ' },
    { type: 'em', children: [{ type: 'text', text: 'b' }] },
    { type: 'text', text: ' dan ' },
    { type: 'del', children: [{ type: 'text', text: 'c' }] },
    { type: 'text', text: ' dan ' },
    { type: 'code', text: '**d**' },
  ])
})
