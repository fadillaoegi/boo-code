import assert from 'node:assert/strict'
import test from 'node:test'
import type { Message } from '@boo/core'
import { renderTranscript } from '../src/transcript.ts'
import { stripAnsi } from '../src/text.ts'

function call(id: string, name: string, args: object): Message {
  return { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }
}

function result(id: string, content: string): Message {
  return { role: 'tool', tool_call_id: id, content }
}

function screen(messages: Message[], max?: number): string {
  return stripAnsi(renderTranscript(messages, 80, max))
}

test('pertanyaan dan jawaban tampil seperti chat, jawaban dirender markdown', () => {
  const output = screen([
    { role: 'user', content: 'apa itu **debounce**?' },
    { role: 'assistant', content: '## Debounce\n\nMenunda **eksekusi** fungsi.' },
  ])
  assert.match(output, /› apa itu \*\*debounce\*\*\?/, 'pertanyaan persis seperti diketik')
  assert.match(output, / {2}Debounce\n/, 'judul tanpa tanda pagar')
  assert.match(output, /Menunda eksekusi fungsi\./, 'tebal tanpa penanda')
  assert.doesNotMatch(output, /## |\*\*eksekusi/)
})

test('pekerjaan tool diringkas dengan baris fase, isi hasil tool tidak ditampilkan', () => {
  const output = screen([
    { role: 'user', content: 'baca dan ubah' },
    call('c1', 'read_file', { path: 'a.ts' }),
    result('c1', 'RAHASIA ISI BERKAS YANG PANJANG'),
    call('c2', 'list_dir', { path: '.' }),
    result('c2', 'a.ts\nb.ts'),
    call('c3', 'edit_file', { path: 'a.ts', old_text: 'x', new_text: 'y' }),
    result('c3', 'Diubah: a.ts'),
    { role: 'assistant', content: 'Selesai.' },
  ])
  assert.match(output, /● Exploring\s+1 file, 1 directory/)
  assert.match(output, /● Applying\s+a\.ts/)
  assert.doesNotMatch(output, /RAHASIA ISI BERKAS/, 'isi hasil tool tidak boleh tampil')
  assert.ok(output.indexOf('Exploring') < output.indexOf('Applying'))
  assert.ok(output.indexOf('Applying') < output.indexOf('Selesai.'))
})

test('penolakan ditampilkan beserta arahannya', () => {
  const output = screen([
    { role: 'user', content: 'jalankan' },
    call('c1', 'bash', { command: 'rm -rf build' }),
    result('c1', 'Ditolak oleh pengguna, dengan arahan: jangan hapus apa pun\nIkuti arahan itu; jangan ulangi tindakan yang ditolak tanpa perubahan.'),
    { role: 'assistant', content: 'Baik.' },
  ])
  assert.match(output, /✗ Jalankan perintah · rm -rf build · ditolak: jangan hapus apa pun/)
  assert.doesNotMatch(output, /● Applying/, 'tool yang ditolak tidak dihitung sebagai pekerjaan')
})

test('kegagalan tool ikut terhitung di ringkasan', () => {
  const output = screen([
    { role: 'user', content: 'uji' },
    call('c1', 'bash', { command: 'pnpm test' }),
    result('c1', 'Gagal: perintah keluar dengan kode 1'),
  ])
  assert.match(output, /● Applying\s+1 command · 1 failed/)
})

test('sesi panjang hanya menampilkan tukar-jawab terakhir', () => {
  const messages: Message[] = []
  for (let i = 1; i <= 25; i += 1) {
    messages.push({ role: 'user', content: `pertanyaan ${i}` }, { role: 'assistant', content: `jawaban ${i}` })
  }
  const output = screen(messages, 20)
  assert.match(output, /… 5 tukar-jawab sebelumnya tidak ditampilkan/)
  assert.doesNotMatch(output, /pertanyaan 5\n/)
  assert.match(output, /pertanyaan 6\n/)
  assert.match(output, /jawaban 25/)
})

test('tukar-jawab dipisah baris kosong dan pertanyaan multibaris tetap utuh', () => {
  const output = screen([
    { role: 'user', content: 'baris satu\nbaris dua' },
    { role: 'assistant', content: 'oke' },
    { role: 'user', content: 'lanjut' },
    { role: 'assistant', content: 'siap' },
  ])
  assert.match(output, /› baris satu\n {2}baris dua\n/)
  assert.match(output, /oke\n\n› lanjut/)
})

test('hasil tool yang berjalan tetap diringkas walau panggilan lain ditolak', () => {
  const output = screen([
    { role: 'user', content: 'ubah dua berkas' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'edit_file', arguments: JSON.stringify({ path: 'a.ts' }) } },
        { id: 'c2', type: 'function', function: { name: 'edit_file', arguments: JSON.stringify({ path: 'b.ts' }) } },
      ],
    },
    result('c1', 'Ditolak oleh pengguna. Jangan ulangi; tanyakan langkah berikutnya.'),
    result('c2', 'Diubah: b.ts'),
  ])
  assert.match(output, /✗ Ubah berkas a\.ts · ditolak/)
  assert.match(output, /● Applying\s+b\.ts/)
})

test('pekerjaan yang dihentikan tampil sebagai baris dibatalkan, bukan kegagalan', async () => {
  const { CANCELLED_REPLY, CANCELLED_TOOL_RESULT } = await import('@boo/core')
  const output = screen([
    { role: 'user', content: 'jalankan sleep' },
    call('c1', 'bash', { command: 'sleep 30' }),
    result('c1', 'Dibatalkan: perintah dihentikan oleh pengguna sebelum selesai.'),
    { role: 'assistant', content: CANCELLED_REPLY },
    { role: 'user', content: 'jelaskan panjang' },
    { role: 'assistant', content: `Saya mulai menjelaskan\n\n${CANCELLED_REPLY}` },
    { role: 'user', content: 'tulis dua' },
    call('c2', 'write_file', { path: 'a.txt', content: 'a' }),
    result('c2', CANCELLED_TOOL_RESULT),
    { role: 'assistant', content: CANCELLED_REPLY },
  ])
  assert.equal(output.match(/✗ Dibatalkan\n/g)?.length, 3)
  assert.match(output, /Saya mulai menjelaskan\n\s*✗ Dibatalkan/)
  assert.doesNotMatch(output, /Applying|failed|\(Dibatalkan oleh pengguna\.\)/)
})

test('catatan /undo tampil sebagai baris, bukan bagian pertanyaan', async () => {
  const { undoNote } = await import('@boo/core')
  const note = undoNote({ checkpointId: 1, prompt: 'buat a', ranCommands: false, entries: [{ label: 'a.txt', action: 'delete', modifiedSince: false, added: 0, removed: 1 }] })
  const output = screen([
    { role: 'user', content: `${note}\n\nlanjut yang lain` },
    { role: 'assistant', content: 'oke' },
  ])
  assert.match(output, /↺ perubahan berkas sebelumnya dibatalkan dengan \/undo\n\n› lanjut yang lain\n/)
  assert.doesNotMatch(output, /Catatan Boo/)
})
