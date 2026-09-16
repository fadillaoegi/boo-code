import assert from 'node:assert/strict'
import test from 'node:test'
import { estimateMessageTokens, trimToBudget } from '../src/agent/context.ts'
import type { Message } from '../src/domain/message.ts'

const system: Message = { role: 'system', content: 'Kamu adalah Boo.' }

function user(content: string): Message {
  return { role: 'user', content }
}

function assistantCall(id: string, path: string): Message {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [{ id, type: 'function', function: { name: 'read_file', arguments: `{"path":"${path}"}` } }],
  }
}

function toolResult(id: string, content: string): Message {
  return { role: 'tool', tool_call_id: id, content }
}

test('percakapan yang muat dikirim utuh', () => {
  const messages = [system, user('halo'), { role: 'assistant' as const, content: 'hai' }]
  const result = trimToBudget(messages, 10_000)
  assert.deepEqual(result.messages, messages)
  assert.equal(result.droppedMessages, 0)
})

test('pesan system selalu dipertahankan meski riwayat dipangkas', () => {
  const messages = [system, ...Array.from({ length: 50 }, (_, i) => user(`pesan ${i} `.repeat(200)))]
  const result = trimToBudget(messages, 2_000)
  assert.equal(result.messages[0].role, 'system')
  assert.ok(result.droppedMessages > 0)
})

test('pesan terbaru yang dipertahankan, bukan yang terlama', () => {
  const messages = [system, user('lama '.repeat(500)), user('baru')]
  const result = trimToBudget(messages, 200)
  assert.equal(result.messages.at(-1)?.content, 'baru')
  assert.ok(!result.messages.some((m) => m.content?.startsWith('lama')))
})

test('hasil tool tidak pernah menjadi pesan pertama setelah system', () => {
  // Titik potong jatuh tepat di hasil tool; harus digeser maju.
  const messages = [
    system,
    user('baca file'),
    assistantCall('call_1', 'a.ts'),
    toolResult('call_1', 'isi file '.repeat(400)),
    user('lanjut'),
  ]
  const result = trimToBudget(messages, 320)
  const afterSystem = result.messages.slice(1)
  assert.notEqual(afterSystem[0]?.role, 'tool', 'pesan tool menggantung akan ditolak API')
})

test('pasangan tool_calls dan hasilnya tetap berurutan', () => {
  const messages = [
    system,
    user('a'),
    assistantCall('call_1', 'a.ts'),
    toolResult('call_1', 'isi a'),
    assistantCall('call_2', 'b.ts'),
    toolResult('call_2', 'isi b'),
  ]
  const result = trimToBudget(messages, 10_000)
  const roles = result.messages.map((m) => m.role)
  for (let i = 0; i < roles.length; i += 1) {
    if (roles[i] === 'tool') {
      assert.equal(roles[i - 1], 'assistant', 'hasil tool harus didahului assistant')
    }
  }
})

/**
 * Regresi: empat hasil read_file raksasa dari satu pesan assistant membuat
 * jalur "tidak ada yang muat" menyisakan pesan tool sendirian, dan API menolak
 * dengan "tool_result must have a corresponding tool_use".
 */
test('hasil tool tidak pernah terpisah dari pemanggilnya meski anggaran habis', () => {
  const besar = 'x'.repeat(50_000)
  const messages: Message[] = [
    system,
    user('baca empat file'),
    {
      role: 'assistant',
      content: null,
      tool_calls: [1, 2, 3, 4].map((n) => ({
        id: `call_${n}`,
        type: 'function' as const,
        function: { name: 'read_file', arguments: `{"path":"besar${n}.js"}` },
      })),
    },
    ...[1, 2, 3, 4].map((n) => toolResult(`call_${n}`, besar)),
  ]

  const result = trimToBudget(messages, 6_000)
  const sent = result.messages

  const toolMessages = sent.filter((m) => m.role === 'tool')
  assert.ok(toolMessages.length, 'hasil tool harus tetap ada')

  const caller = sent.find((m) => m.role === 'assistant' && m.tool_calls?.length)
  assert.ok(caller, 'pesan assistant pemanggil wajib ikut terkirim')

  // Setiap tool_call wajib punya hasil, dan setiap hasil wajib punya pemanggil.
  const calledIds = new Set(caller!.tool_calls!.map((c) => c.id))
  const resultIds = new Set(toolMessages.map((m) => m.tool_call_id))
  assert.deepEqual([...calledIds].sort(), [...resultIds].sort())
  assert.ok(result.estimatedTokens <= 6_000)
})

test('blok tool utuh dipertahankan saat masih muat', () => {
  const messages: Message[] = [
    system,
    user('lama '.repeat(2_000)),
    assistantCall('call_9', 'a.ts'),
    toolResult('call_9', 'isi singkat'),
  ]
  const result = trimToBudget(messages, 600)
  const roles = result.messages.map((m) => m.role)
  assert.deepEqual(roles, ['system', 'assistant', 'tool'], 'pesan lama dibuang, blok tool utuh')
})

test('satu pesan raksasa dipotong, bukan dibuang', () => {
  const messages = [system, user('x'.repeat(400_000))]
  const result = trimToBudget(messages, 1_000)
  assert.equal(result.messages.length, 2)
  assert.ok(result.messages[1].content!.includes('dipotong'))
  assert.ok(result.estimatedTokens <= 1_000)
})

test('token pada tool_calls ikut dihitung', () => {
  const plain = estimateMessageTokens({ role: 'assistant', content: 'hai' })
  const withCall = estimateMessageTokens(assistantCall('call_1', 'sangat/panjang/sekali/path.ts'))
  assert.ok(withCall > plain)
})
