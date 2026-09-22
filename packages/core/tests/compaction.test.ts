import assert from 'node:assert/strict'
import test from 'node:test'
import { Agent, type AgentEvent } from '../src/agent/loop.ts'
import { alignCut, applyCompaction, chooseCut, renderForSummary, SUMMARY_HEADER, type Compaction } from '../src/agent/compaction.ts'
import type { Message } from '../src/domain/message.ts'
import type { NineRouterProvider } from '../src/provider/nineRouter.ts'
import { createDefaultRegistry } from '../src/tools/index.ts'
import { BOO_SYSTEM_PROMPT } from '../src/agent/prompt.ts'
import { estimateMessageTokens, estimateToolSchemaTokens } from '../src/agent/context.ts'

const big = (label: string) => `${label} ${'x'.repeat(4_000)}`

function exchange(question: string, answer: string): Message[] {
  return [{ role: 'user', content: question }, { role: 'assistant', content: answer }]
}

/** Provider palsu yang membedakan permintaan ringkasan dari percakapan biasa. */
function provider(options: { summary?: string | Error } = {}) {
  const chats: Message[][] = []
  const summaries: Message[][] = []
  const fake = {
    model: 'palsu',
    stream(messages: Message[], tools: unknown[]) {
      const isSummary = !tools.length && String(messages[0].content).startsWith('You summarize')
      ;(isSummary ? summaries : chats).push(messages.map((message) => ({ ...message })))
      // eslint-disable-next-line require-yield
      return (async function* reply() {
        if (isSummary && options.summary instanceof Error) throw options.summary
        const content = isSummary ? (options.summary as string | undefined) ?? 'RINGKASAN: pengguna meminta A lalu B.' : 'jawaban'
        return { finishReason: 'stop', message: { role: 'assistant' as const, content } }
      })()
    },
  } as unknown as NineRouterProvider
  return { fake, chats, summaries }
}

async function collect(events: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const list: AgentEvent[] = []
  for await (const event of events) list.push(event)
  return list
}

test('titik potong: seawal mungkin di awal permintaan pengguna yang menyisakan ekor kecil', () => {
  const history = [...exchange(big('a'), 'A'), ...exchange(big('b'), 'B'), ...exchange('c', 'C')]
  // Ekor dari "c" kecil, dari "b" sekitar 1000 token.
  assert.equal(chooseCut(history, 0, 10_000), 2, 'ekor sejak b muat dalam 35% dari 10.000')
  assert.equal(chooseCut(history, 0, 2_000), 4, 'hanya ekor sejak c yang muat')
  assert.equal(chooseCut(history, 4, 2_000), null, 'tidak ada yang baru untuk diringkas')
  assert.equal(chooseCut([...exchange(big('a'), 'A'), { role: 'user', content: big('besar sekali') }], 0, 100), 2, 'permintaan terakhir dipertahankan walau besar')
})

test('titik potong diselaraskan ke awal permintaan pengguna', () => {
  const history: Message[] = [...exchange('a', 'A'), { role: 'tool', tool_call_id: 'x', content: 'hasil' }, ...exchange('b', 'B')]
  assert.equal(alignCut(history, 2), 3)
  assert.equal(alignCut(history, 99), 5)
})

test('ringkasan ditempel di depan pesan pengguna pertama yang tersisa', () => {
  const history = [...exchange('lama', 'L'), ...exchange('baru', 'B')]
  const compaction: Compaction = { summary: 'isi ringkasan', upTo: 2 }
  const sent = applyCompaction(history, compaction)
  assert.equal(sent.length, 2)
  assert.equal(sent[0].role, 'user')
  assert.equal(sent[0].content, `${SUMMARY_HEADER}\n\nisi ringkasan\n\n---\n\nbaru`)
  assert.deepEqual(applyCompaction(history, null), history)
})

test('bahan ringkasan memotong hasil tool panjang dan mengutamakan bagian terbaru', () => {
  const text = renderForSummary([
    { role: 'user', content: 'baca' },
    { role: 'assistant', content: null, tool_calls: [{ id: '1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }] },
    { role: 'tool', tool_call_id: '1', content: 'y'.repeat(10_000) },
  ], 100_000)
  assert.match(text, /PENGGUNA:\nbaca\n\nBOO memanggil read_file: \{"path":"a.ts"\}\n\nHASIL TOOL:\ny+ \[… 8500 karakter dipotong\]$/)
  assert.match(renderForSummary(exchange('awal', 'akhir'), 20), /^\[… bagian awal dilewati …\]/)
})

test('konteks hampir penuh: bagian lama diringkas, riwayat lengkap tetap utuh', async () => {
  const { fake, chats, summaries } = provider()
  const saved: Compaction[] = []
  const history = [...exchange(big('pertanyaan pertama'), 'jawaban pertama'), ...exchange(big('pertanyaan kedua'), 'jawaban kedua')]
  const registry = createDefaultRegistry()
  // Sisakan ruang tetap di luar system prompt dan skema tool agar penambahan
  // instruksi/tool tidak mengubah bagian riwayat yang diuji fixture ini.
  const budget = Math.max(3_000, estimateMessageTokens({ role: 'system', content: BOO_SYSTEM_PROMPT }) + estimateToolSchemaTokens(registry.schemas()) + 1_400)
  const agent = new Agent({
    provider: fake,
    registry,
    workspace: '/tmp',
    askPermission: async () => true,
    maxContextTokens: budget,
    history,
    onCompaction: (compaction) => saved.push(compaction),
  })

  const events = await collect(agent.send('pertanyaan ketiga'))
  assert.deepEqual(events.filter((event) => event.type.startsWith('compact')).map((event) => event.type), ['compacting', 'compacted'])
  assert.equal(summaries.length, 1)
  // Ekor sejak pertanyaan kedua masih muat dalam 35% anggaran, jadi hanya yang pertama diringkas.
  assert.match(String(summaries[0][1].content), /pertanyaan pertama/)
  assert.doesNotMatch(String(summaries[0][1].content), /pertanyaan kedua/)
  assert.deepEqual(saved, [{ summary: 'RINGKASAN: pengguna meminta A lalu B.', upTo: 2 }])

  const sent = chats.at(-1)!.filter((message) => message.role !== 'system')
  assert.deepEqual(sent.map((message) => message.role), ['user', 'assistant', 'user'])
  assert.match(String(sent[0].content), /^\[Ringkasan[\s\S]*RINGKASAN[\s\S]*---\n\npertanyaan kedua/)
  assert.equal(sent[2].content, 'pertanyaan ketiga')
  assert.ok(!events.some((event) => event.type === 'context-trimmed'), 'ringkasan membuat pemangkasan tidak perlu')
  assert.equal(agent.history.length, 7, 'system, empat pesan lama, pertanyaan, dan jawaban tetap tersimpan')
})

test('ringkasan gagal: pemangkasan biasa menjadi jaring pengaman', async () => {
  const { fake, chats } = provider({ summary: new Error('9Router sibuk') })
  const agent = new Agent({
    provider: fake,
    registry: createDefaultRegistry(),
    workspace: '/tmp',
    askPermission: async () => true,
    maxContextTokens: 3_000,
    history: [...exchange(big('a'), 'A'), ...exchange(big('b'), 'B'), ...exchange(big('c'), 'C')],
  })
  const events = await collect(agent.send('d'))
  assert.ok(events.some((event) => event.type === 'compaction-failed'))
  assert.ok(events.some((event) => event.type === 'context-trimmed'))
  assert.equal(events.at(-1)?.type, 'turn-end')
  assert.equal(chats.length, 1)
})

test('sesi yang dilanjutkan memakai ringkasannya; /compact meringkas semua', async () => {
  const { fake, chats, summaries } = provider({ summary: 'RINGKASAN BARU' })
  const agent = new Agent({
    provider: fake,
    registry: createDefaultRegistry(),
    workspace: '/tmp',
    askPermission: async () => true,
    history: [...exchange('lama', 'L'), ...exchange('tengah', 'T')],
    compaction: { summary: 'RINGKASAN LAMA', upTo: 2 },
  })
  await collect(agent.send('baru'))
  const sent = chats[0].filter((message) => message.role !== 'system')
  assert.deepEqual(sent.map((message) => message.role), ['user', 'assistant', 'user'])
  assert.match(String(sent[0].content), /RINGKASAN LAMA[\s\S]*tengah$/)

  const events = await collect(agent.compact())
  assert.equal(events.at(-1)?.type, 'compacted')
  assert.match(String(summaries[0][1].content), /RINGKASAN LAMA[\s\S]*tengah[\s\S]*baru/, 'ringkasan lama ikut digabung')
  assert.deepEqual(agent.currentCompaction, { summary: 'RINGKASAN BARU', upTo: 6 })

  await collect(agent.send('setelah compact'))
  const after = chats.at(-1)!.filter((message) => message.role !== 'system')
  assert.equal(after.length, 1)
  assert.match(String(after[0].content), /RINGKASAN BARU[\s\S]*setelah compact$/)

  assert.deepEqual(await collect(agent.compact()).then((list) => list.length), 2, 'dua pesan baru masih dapat diringkas')
  assert.deepEqual(await collect(agent.compact()), [], 'tanpa pesan baru, tidak ada yang diringkas')
})
