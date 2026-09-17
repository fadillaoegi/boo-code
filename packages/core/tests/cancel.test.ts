import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Agent, CANCELLED_REPLY, CANCELLED_TOOL_RESULT, type AgentEvent } from '../src/agent/loop.ts'
import type { Message, ToolCall } from '../src/domain/message.ts'
import type { NineRouterProvider } from '../src/provider/nineRouter.ts'
import { createDefaultRegistry } from '../src/tools/index.ts'

/** Menunggu, tetapi berhenti seketika bila sinyal menyala — seperti fetch sungguhan. */
function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Dibatalkan', 'AbortError'))
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new DOMException('Dibatalkan', 'AbortError'))
    }, { once: true })
  })
}

type Turn = (signal?: AbortSignal) => AsyncGenerator<{ type: 'text'; delta: string }, { finishReason: string; message: Message }>

/** Provider palsu yang menjalankan skenario per putaran, lalu menjawab "selesai". */
function provider(turns: Turn[], seen: Message[][]) {
  let index = 0
  return {
    model: 'palsu',
    stream(messages: Message[], _tools: unknown, signal?: AbortSignal) {
      seen.push(messages.map((message) => ({ ...message })))
      const turn = turns[index++]
      if (turn) return turn(signal)
      return (async function* finish() {
        yield { type: 'text' as const, delta: 'selesai' }
        return { finishReason: 'stop', message: { role: 'assistant' as const, content: 'selesai' } }
      })()
    },
  } as unknown as NineRouterProvider
}

function toolCall(id: string, name: string, args: object): ToolCall {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}

async function agentWith(turns: Turn[], seen: Message[][] = []) {
  const workspace = await mkdtemp(join(tmpdir(), 'boo-batal-'))
  const agent = new Agent({
    provider: provider(turns, seen),
    registry: createDefaultRegistry(),
    workspace,
    askPermission: async () => true,
  })
  return { agent, seen }
}

async function collect(events: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const list: AgentEvent[] = []
  for await (const event of events) list.push(event)
  return list
}

/** Riwayat sah: setiap tool_call punya hasil, dan tidak ada dua giliran user beruntun. */
function assertValidHistory(history: readonly Message[]) {
  history.forEach((message, index) => {
    for (const call of message.tool_calls ?? []) {
      assert.ok(history.some((item) => item.role === 'tool' && item.tool_call_id === call.id), `tool_call ${call.id} tanpa hasil`)
    }
    if (message.role === 'user' && index > 0) {
      assert.notEqual(history[index - 1].role, 'user', 'dua pesan user beruntun')
      assert.notEqual(history[index - 1].role, 'tool', 'pesan user tepat setelah hasil tool')
    }
  })
  assert.equal(history.at(-1)?.role, 'assistant', 'giliran terakhir harus milik assistant')
}

test('dihentikan saat jawaban mengalir: teks yang terlanjur tampil disimpan dengan tanda dibatalkan', async () => {
  const controller = new AbortController()
  const { agent } = await agentWith([
    async function* (signal) {
      yield { type: 'text', delta: 'Saya mulai menjelaskan' }
      controller.abort()
      await wait(5_000, signal)
      return { finishReason: 'stop', message: { role: 'assistant', content: 'tidak pernah sampai' } }
    },
  ])

  const started = Date.now()
  const events = await collect(agent.send('jelaskan', { signal: controller.signal }))

  assert.ok(Date.now() - started < 2_000, 'harus berhenti seketika, bukan menunggu jawaban selesai')
  assert.equal(events.at(-1)?.type, 'cancelled')
  assert.ok(!events.some((event) => event.type === 'error'), 'pembatalan bukan error')
  assert.equal(agent.history.at(-1)?.content, `Saya mulai menjelaskan\n\n${CANCELLED_REPLY}`)
  assertValidHistory(agent.history.slice(1))
})

test('dihentikan saat perintah berjalan: prosesnya ikut dihentikan', async () => {
  const controller = new AbortController()
  const { agent } = await agentWith([
    // Model langsung meminta tool tanpa mengalirkan teks.
    // eslint-disable-next-line require-yield
    async function* () {
      return {
        finishReason: 'tool_calls',
        message: { role: 'assistant', content: null, tool_calls: [toolCall('c1', 'bash', { command: 'sleep 10' })] },
      }
    },
  ])

  setTimeout(() => controller.abort(), 300)
  const started = Date.now()
  const events = await collect(agent.send('tidur', { signal: controller.signal }))

  assert.ok(Date.now() - started < 3_000, `sleep 10 seharusnya dihentikan, bukan ditunggu (${Date.now() - started} ms)`)
  assert.equal(events.at(-1)?.type, 'cancelled')
  const result = agent.history.find((message) => message.role === 'tool')
  assert.match(String(result?.content), /Dibatalkan/)
  assertValidHistory(agent.history.slice(1))
})

test('dihentikan sebelum tool berikutnya: tool yang tersisa diberi hasil dibatalkan tanpa dijalankan', async () => {
  const controller = new AbortController()
  const workspace = await mkdtemp(join(tmpdir(), 'boo-batal-'))
  const agent = new Agent({
    provider: provider([
      // Model langsung meminta tool tanpa mengalirkan teks.
      // eslint-disable-next-line require-yield
      async function* () {
        return {
          finishReason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              toolCall('c1', 'write_file', { path: 'satu.txt', content: 'a' }),
              toolCall('c2', 'write_file', { path: 'dua.txt', content: 'b' }),
            ],
          },
        }
      },
    ], []),
    registry: createDefaultRegistry(),
    workspace,
    // Pengguna menekan Esc tepat saat izin pertama diminta.
    askPermission: async () => {
      controller.abort()
      return true
    },
  })

  const events = await collect(agent.send('tulis dua berkas', { signal: controller.signal }))
  const { existsSync } = await import('node:fs')

  assert.equal(events.at(-1)?.type, 'cancelled')
  assert.ok(!existsSync(join(workspace, 'satu.txt')) && !existsSync(join(workspace, 'dua.txt')), 'tidak ada berkas yang ditulis')
  const results = agent.history.filter((message) => message.role === 'tool').map((message) => message.content)
  assert.deepEqual(results, [CANCELLED_TOOL_RESULT, CANCELLED_TOOL_RESULT])
  assertValidHistory(agent.history.slice(1))
})

test('setelah dihentikan, permintaan berikutnya berjalan dengan riwayat yang sah', async () => {
  const controller = new AbortController()
  const seen: Message[][] = []
  const { agent } = await agentWith([
    async function* (signal) {
      yield { type: 'text', delta: 'setengah' }
      controller.abort()
      await wait(5_000, signal)
      return { finishReason: 'stop', message: { role: 'assistant', content: 'x' } }
    },
  ], seen)

  await collect(agent.send('pertama', { signal: controller.signal }))
  const events = await collect(agent.send('kedua'))

  assert.equal(events.at(-1)?.type, 'turn-end')
  const sent = seen.at(-1)!.filter((message) => message.role !== 'system')
  assert.deepEqual(sent.map((message) => message.role), ['user', 'assistant', 'user'])
  assertValidHistory(agent.history.slice(1))
})

test('permintaan tanpa sinyal berjalan seperti biasa', async () => {
  const { agent } = await agentWith([])
  const events = await collect(agent.send('halo'))
  assert.ok(!events.some((event) => event.type === 'cancelled'))
  assert.equal(agent.history.at(-1)?.content, 'selesai')
})
