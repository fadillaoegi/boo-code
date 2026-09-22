import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Agent, type AgentEvent } from '../src/agent/loop.ts'
import type { Message, ToolCall } from '../src/domain/message.ts'
import { createRegistry, type Tool } from '../src/domain/tool.ts'
import type { NineRouterProvider } from '../src/provider/nineRouter.ts'
import { MAX_STEERING_CHARACTERS, normalizeSteering, steeringPromptTitle, USER_STEERING_MARK } from '../src/agent/steering.ts'

function toolCall(id: string, name: string): ToolCall {
  return { id, type: 'function', function: { name, arguments: '{}' } }
}

async function collect(events: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const output: AgentEvent[] = []
  for await (const event of events) output.push(event)
  return output
}

test('arahan saat model berjalan membatalkan tool lama dan masuk ke turn berikutnya', async () => {
  let release!: () => void
  let started!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const modelStarted = new Promise<void>((resolve) => { started = resolve })
  const seen: Message[][] = []
  let turn = 0
  const provider = {
    model: 'manual-model',
    stream(messages: Message[]) {
      seen.push(messages.map((message) => ({ ...message })))
      turn += 1
      // eslint-disable-next-line require-yield
      if (turn === 1) return (async function* () {
        started()
        await gate
        return { finishReason: 'tool_calls', message: { role: 'assistant' as const, content: null, tool_calls: [toolCall('old-tool', 'dangerous_write')] } }
      })()
      return (async function* () {
        yield { type: 'text' as const, delta: 'Mengikuti arahan terbaru.' }
        return { finishReason: 'stop', message: { role: 'assistant' as const, content: 'Mengikuti arahan terbaru.' } }
      })()
    },
  } as unknown as NineRouterProvider
  let runs = 0
  const dangerous: Tool = {
    name: 'dangerous_write', description: 'write', risk: 'safe', mutatesWorkspace: true,
    schema: { type: 'function', function: { name: 'dangerous_write', description: 'write', parameters: { type: 'object', properties: {} } } },
    preview: () => 'ubah file', async run() { runs += 1; return { content: 'changed' } },
  }
  const agent = new Agent({
    provider, registry: createRegistry([dangerous] as never),
    workspace: mkdtempSync(join(tmpdir(), 'boo-steering-')),
    askPermission: async () => true, verifyCompletion: false,
  })

  const pending = collect(agent.send('ubah implementasi lama'))
  await modelStarted
  assert.equal(agent.steer('Jangan ubah file; cukup jelaskan risikonya.'), 1)
  release()
  const events = await pending

  assert.equal(runs, 0, 'tool berdasarkan instruksi lama tidak boleh dijalankan')
  assert.equal(events.filter((event) => event.type === 'steering').length, 1)
  assert.match(seen[1].find((message) => message.role === 'tool')?.content ?? '', /Dilewati/)
  const steering = seen[1].find((message) => message.role === 'user' && message.content?.startsWith(USER_STEERING_MARK))
  assert.match(steering?.content ?? '', /Jangan ubah file/)
  assert.equal(agent.history.at(-1)?.content, 'Mengikuti arahan terbaru.')
})

test('arahan saat tool berjalan menunggu hasil tool lalu diterapkan sebelum turn berikutnya', async () => {
  let release!: () => void
  let toolStarted!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const started = new Promise<void>((resolve) => { toolStarted = resolve })
  const seen: Message[][] = []
  let turn = 0
  const provider = {
    model: 'manual-model',
    stream(messages: Message[]) {
      seen.push(messages)
      turn += 1
      // eslint-disable-next-line require-yield
      if (turn === 1) return (async function* () {
        return { finishReason: 'tool_calls', message: { role: 'assistant' as const, content: null, tool_calls: [toolCall('running-tool', 'slow_read')] } }
      })()
      // eslint-disable-next-line require-yield
      return (async function* () {
        return { finishReason: 'stop', message: { role: 'assistant' as const, content: 'Disesuaikan setelah pembacaan.' } }
      })()
    },
  } as unknown as NineRouterProvider
  let runs = 0
  const slowRead: Tool = {
    name: 'slow_read', description: 'read', risk: 'safe',
    schema: { type: 'function', function: { name: 'slow_read', description: 'read', parameters: { type: 'object', properties: {} } } },
    preview: () => 'baca perlahan',
    async run() { runs += 1; toolStarted(); await gate; return { content: 'hasil baca' } },
  }
  const agent = new Agent({
    provider, registry: createRegistry([slowRead] as never),
    workspace: mkdtempSync(join(tmpdir(), 'boo-steering-')),
    askPermission: async () => true, verifyCompletion: false,
  })

  const pending = collect(agent.send('baca lalu jelaskan'))
  await started
  assert.equal(agent.steer('Fokus hanya pada kompatibilitas.'), 1)
  release()
  const events = await pending

  assert.equal(runs, 1)
  assert.ok(events.some((event) => event.type === 'tool-end'))
  assert.ok(events.some((event) => event.type === 'steering'))
  assert.deepEqual(seen[1].filter((message) => message.role !== 'system').map((message) => message.role), ['user', 'assistant', 'tool', 'user'])
})

test('steering hanya diterima saat request aktif, dibatasi, dan marker dapat ditampilkan ulang', async () => {
  const provider = {
    model: 'manual-model',
    stream() {
      // eslint-disable-next-line require-yield
      return (async function* () {
        return { finishReason: 'stop', message: { role: 'assistant' as const, content: 'selesai' } }
      })()
    },
  } as unknown as NineRouterProvider
  const agent = new Agent({
    provider, registry: createRegistry([] as never),
    workspace: mkdtempSync(join(tmpdir(), 'boo-steering-')),
    askPermission: async () => true,
  })
  assert.equal(agent.steer('belum aktif'), 0)
  assert.throws(() => normalizeSteering('a'.repeat(MAX_STEERING_CHARACTERS + 1)), /maksimal/)
  assert.equal(steeringPromptTitle(`${USER_STEERING_MARK}\nfokus ke test`), 'fokus ke test')
  assert.equal(steeringPromptTitle(`feedback internal\n\n${USER_STEERING_MARK}\njangan ubah API`), 'jangan ubah API')
  await collect(agent.send('task'))
  assert.equal(agent.steer('sudah selesai'), 0)
})
