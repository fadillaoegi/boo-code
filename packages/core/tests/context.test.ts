import assert from 'node:assert/strict'
import test from 'node:test'
import { contextRelevanceTerms, estimateMessageTokens, estimateToolSchemaTokens, inspectContext, messageContextBudget, trimToBudget } from '../src/agent/context.ts'
import type { Message, ToolSchema } from '../src/domain/message.ts'

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

test('context inspector menghitung skema tool, gambar, reasoning, dan metadata compaction', () => {
  const schemas: ToolSchema[] = [{
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Membaca file dengan aman.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  }]
  const messages: Message[] = [
    system,
    { role: 'user', content: 'lihat ini', images: [{ id: '1', name: 'a.png', mediaType: 'image/png', ref: 'a', bytes: 10 }] },
    { role: 'assistant', content: 'baik', reasoning_content: 'rencana internal yang cukup panjang' },
  ]
  const report = inspectContext(messages, schemas, 10_000, { historyMessages: 12, summarizedMessages: 7 })
  const total = Object.values(report.breakdown).reduce((sum, value) => sum + value, 0)

  assert.equal(report.currentTokens, total)
  assert.equal(report.breakdown.images, 1_200)
  assert.ok(report.breakdown.assistant > estimateMessageTokens({ role: 'assistant', content: 'baik' }))
  assert.equal(report.breakdown.toolSchemas, estimateToolSchemaTokens(schemas))
  assert.equal(report.historyMessages, 12)
  assert.equal(report.summarizedMessages, 7)
  assert.equal(report.compactionActive, true)
})

test('skema tool disisihkan dari budget dan inspector melaporkan trimming kritis', () => {
  const schemas: ToolSchema[] = [{
    type: 'function',
    function: {
      name: 'large_tool',
      description: 'x'.repeat(2_000),
      parameters: { type: 'object', properties: {} },
    },
  }]
  const limit = 1_000
  const messages = [system, user('lama '.repeat(1_000)), user('permintaan terbaru')]
  const available = messageContextBudget(limit, schemas)
  const report = inspectContext(messages, schemas, limit)

  assert.equal(available, limit - estimateToolSchemaTokens(schemas))
  assert.ok(report.droppedMessages > 0)
  assert.equal(report.pressure, 'critical')
  assert.ok(report.sentTokens <= limit)
  assert.equal(report.sentMessages, 2)
})

test('reasoning content ikut dipotong ketika satu blok melebihi budget', () => {
  const messages: Message[] = [system, { role: 'assistant', content: 'jawaban', reasoning_content: 'r'.repeat(40_000) }]
  const result = trimToBudget(messages, 500)
  assert.ok(result.messages.at(-1)?.reasoning_content?.includes('dipotong'))
  assert.ok(result.estimatedTokens <= 500)
})

test('token relevansi mempertahankan path dan identifier tetapi membuang kata umum', () => {
  const terms = contextRelevanceTerms('Tolong lanjut implementasi parser checkout di src/cart/checkout_parser.ts untuk error ini')
  assert.ok(terms.includes('src/cart/checkout_parser.ts'))
  assert.ok(terms.includes('checkout'))
  assert.ok(terms.includes('parser'))
  assert.equal(terms.includes('untuk'), false)
  assert.equal(terms.includes('error'), false)
})

test('pemangkasan relevansi menyelamatkan bukti lama beserta pasangan tool-nya', () => {
  const noise = (label: string): Message => ({ role: 'assistant', content: `${label} ${'netral '.repeat(42)}` })
  const messages: Message[] = [
    system,
    user('perbaiki checkout parser'),
    assistantCall('relevant', 'src/cart/checkout_parser.ts'),
    toolResult('relevant', `CheckoutParser parseCart calculate_total ${'bukti '.repeat(35)}`),
    noise('noise-1'), noise('noise-2'), noise('noise-3'), noise('noise-4'),
    { role: 'assistant', content: 'langkah terbaru' },
  ]
  const result = trimToBudget(messages, 330, { focus: 'perbaiki CheckoutParser di src/cart/checkout_parser.ts' })

  assert.ok(result.droppedMessages > 0)
  assert.ok(result.prioritizedMessages > 0)
  const caller = result.messages.find((message) => message.role === 'assistant' && message.tool_calls?.some((call) => call.id === 'relevant'))
  const evidence = result.messages.find((message) => message.role === 'tool' && message.tool_call_id === 'relevant')
  assert.ok(caller, 'assistant tool call relevan dipertahankan')
  assert.ok(evidence, 'hasil tool relevan dipertahankan sebagai satu blok')
  assert.equal(result.messages.at(-1)?.content, 'langkah terbaru')
  assert.ok(result.estimatedTokens <= 330)
})

test('seluruh system prompt berurutan dipertahankan saat seleksi relevansi aktif', () => {
  const messages: Message[] = [
    system,
    { role: 'system', content: 'aturan proyek penting' },
    { role: 'system', content: 'pengingat verifikasi penting' },
    user(`lama ${'x'.repeat(2_000)}`),
    user('perbaiki auth middleware'),
  ]
  const result = trimToBudget(messages, 180, { focus: 'auth middleware' })
  assert.deepEqual(result.messages.slice(0, 3).map((message) => message.content), [
    'Kamu adalah Boo.', 'aturan proyek penting', 'pengingat verifikasi penting',
  ])
  assert.equal(result.messages.at(-1)?.content, 'perbaiki auth middleware')
})
