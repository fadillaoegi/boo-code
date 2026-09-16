import assert from 'node:assert/strict'
import test from 'node:test'
import { INTERRUPTED_REPLY, INTERRUPTED_TOOL_RESULT, repairHistory } from '../src/agent/history.ts'
import type { Message } from '../src/domain/message.ts'

function call(...ids: string[]): Message {
  return {
    role: 'assistant',
    content: null,
    tool_calls: ids.map((id) => ({ id, type: 'function' as const, function: { name: 'read_file', arguments: '{}' } })),
  }
}

function result(id: string, content = 'isi'): Message {
  return { role: 'tool', tool_call_id: id, content }
}

/** Setiap tool_use punya tool_result dan sebaliknya — syarat API model. */
function assertValid(messages: Message[]) {
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]
    if (message.role === 'tool') {
      let j = i - 1
      while (j >= 0 && messages[j].role === 'tool') j -= 1
      const caller = messages[j]
      assert.ok(caller?.role === 'assistant', 'hasil tool harus didahului assistant')
      assert.ok(caller.tool_calls?.some((c) => c.id === message.tool_call_id), 'hasil tool harus milik pemanggilnya')
    }
    for (const c of message.tool_calls ?? []) {
      const answered = messages.slice(i + 1).some((m) => m.role === 'tool' && m.tool_call_id === c.id)
      assert.ok(answered, `panggilan ${c.id} harus punya hasil`)
    }
  }
}

test('riwayat yang utuh tidak diubah', () => {
  const history: Message[] = [
    { role: 'user', content: 'baca a' },
    call('c1'),
    result('c1'),
    { role: 'assistant', content: 'selesai' },
  ]
  const repaired = repairHistory(history)
  assert.deepEqual(repaired.messages, history)
  assert.equal(repaired.filledToolResults, 0)
  assert.equal(repaired.filledReplies, 0)
  assert.equal(repaired.droppedMessages, 0)
})

test('proses mati saat tool berjalan: panggilan tanpa hasil diberi hasil pengganti', () => {
  const history: Message[] = [
    { role: 'user', content: 'baca dua file' },
    call('c1', 'c2'),
    result('c1'),
    // Proses berhenti sebelum c2 selesai.
  ]
  const repaired = repairHistory(history)
  assertValid(repaired.messages)
  assert.equal(repaired.filledToolResults, 1)
  assert.equal(repaired.messages.at(-2)?.content, INTERRUPTED_TOOL_RESULT)
  assert.equal(repaired.messages.at(-1)?.role, 'assistant')
})

test('hasil pengganti diletakkan di dalam blok, sebelum pesan berikutnya', () => {
  const history: Message[] = [
    { role: 'user', content: 'a' },
    call('c1', 'c2'),
    result('c2'),
    { role: 'user', content: 'lanjut' },
  ]
  const repaired = repairHistory(history)
  assertValid(repaired.messages)
  assert.deepEqual(repaired.messages.map((m) => m.role), ['user', 'assistant', 'tool', 'tool', 'assistant', 'user', 'assistant'])
})

test('hasil tool yatim dibuang', () => {
  const history: Message[] = [
    result('hilang'),
    { role: 'user', content: 'halo' },
    { role: 'assistant', content: 'hai' },
    result('juga-hilang'),
  ]
  const repaired = repairHistory(history)
  assertValid(repaired.messages)
  assert.deepEqual(repaired.messages.map((m) => m.role), ['user', 'assistant'])
  assert.equal(repaired.droppedMessages, 2)
})

test('hasil tool ganda atau milik panggilan lain dibuang', () => {
  const history: Message[] = [
    { role: 'user', content: 'a' },
    call('c1'),
    result('c1', 'pertama'),
    result('c1', 'ganda'),
    result('lain'),
  ]
  const repaired = repairHistory(history)
  assertValid(repaired.messages)
  assert.equal(repaired.messages.filter((m) => m.role === 'tool').length, 1)
  assert.equal(repaired.messages.find((m) => m.role === 'tool')?.content, 'pertama')
})

test('pesan system lama dibuang agar prompt terbaru yang dipakai', () => {
  const repaired = repairHistory([
    { role: 'system', content: 'prompt lama' },
    { role: 'user', content: 'halo' },
  ])
  assert.ok(!repaired.messages.some((m) => m.role === 'system'))
})

test('pertanyaan terakhir yang belum dijawab diberi jawaban pengganti', () => {
  const repaired = repairHistory([
    { role: 'user', content: 'halo' },
    { role: 'assistant', content: 'hai' },
    { role: 'user', content: 'pertanyaan yang terputus' },
  ])
  assert.equal(repaired.filledReplies, 1)
  assert.equal(repaired.messages.at(-1)?.content, INTERRUPTED_REPLY)
  // Pertanyaan baru tidak akan menjadi pesan user kedua berturut-turut.
  assert.equal(repaired.messages.at(-1)?.role, 'assistant')
})

test('celah jawaban di tengah riwayat ikut diperbaiki', () => {
  // Berkas sesi yang pernah dilanjutkan: jawaban pengganti tidak tersimpan,
  // sehingga pertanyaan terputus langsung disusul pertanyaan dari sesi berikutnya.
  const repaired = repairHistory([
    { role: 'user', content: 'terputus' },
    { role: 'user', content: 'pertanyaan setelah dilanjutkan' },
    { role: 'assistant', content: 'jawaban' },
  ])
  assert.deepEqual(repaired.messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant'])
  assert.equal(repaired.filledReplies, 1)
})

test('hasil tool yang tidak ditanggapi sebelum pertanyaan berikutnya ikut diperbaiki', () => {
  const repaired = repairHistory([
    { role: 'user', content: 'baca' },
    call('c1'),
    result('c1'),
    { role: 'user', content: 'lanjut' },
  ])
  assertValid(repaired.messages)
  assert.deepEqual(repaired.messages.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant', 'user', 'assistant'])
})
