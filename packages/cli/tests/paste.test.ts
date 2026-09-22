import assert from 'node:assert/strict'
import test from 'node:test'
import { isShiftEnter, MultilineInput, normalizePaste, PasteStore } from '../src/paste.ts'

test('tempelan satu baris disisipkan apa adanya', () => {
  const store = new PasteStore()
  assert.equal(store.insert('pnpm test\r'), 'pnpm test')
})

test('tempelan banyak baris diwakili penanda dan dikembalikan utuh saat dikirim', () => {
  const store = new PasteStore()
  const log = 'TypeError: x is undefined\r    at a (app.ts:1)\r    at b (app.ts:2)\r'
  const placeholder = store.insert(log)
  assert.equal(placeholder, '[Tempelan #1 · 3 baris]')
  const second = store.insert('satu\ndua')
  assert.equal(second, '[Tempelan #2 · 2 baris]')

  const sent = store.expand(`kenapa error ini? ${placeholder} dan ini ${second}`)
  assert.equal(sent, 'kenapa error ini? TypeError: x is undefined\n    at a (app.ts:1)\n    at b (app.ts:2) dan ini satu\ndua')
})

test('penanda yang diketik sendiri tanpa tempelan dibiarkan', () => {
  assert.equal(new PasteStore().expand('[Tempelan #7 · 3 baris]'), '[Tempelan #7 · 3 baris]')
})

test('baris baru CRLF dan CR disamakan', () => {
  assert.equal(normalizePaste('a\r\nb\rc\n\n'), 'a\nb\nc')
})

test('Shift+Enter dari terminal modern maupun lama dikenali', () => {
  assert.equal(isShiftEnter({ name: 'return', shift: true, sequence: '\r' }), true)
  assert.equal(isShiftEnter({ name: 'return', meta: true, sequence: '\u001b\r' }), true)
  assert.equal(isShiftEnter({ sequence: '\u001b[13;2u' }), true)
  assert.equal(isShiftEnter({ name: 'return', sequence: '\r' }), false)
})

test('baris Shift+Enter disatukan dan Enter biasa mengirim seluruh prompt', () => {
  const input = new MultilineInput()
  input.continue('jelaskan error ini:')
  input.continue('  TypeError: x')
  assert.equal(input.submit('dan cara memperbaikinya'), 'jelaskan error ini:\n  TypeError: x\ndan cara memperbaikinya')
  assert.equal(input.submit('pesan berikutnya'), 'pesan berikutnya')
})
