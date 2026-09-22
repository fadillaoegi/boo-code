import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Agent, type AgentEvent } from '../src/agent/loop.ts'
import { normalizeToolCallIds, ToolProtocolCircuitBreaker, TOOL_PROTOCOL_GUARD_MARK, TOOL_PROTOCOL_STOPPED_REPLY, toolProtocolName } from '../src/agent/toolProtocol.ts'
import type { Message, ToolCall, ToolSchema } from '../src/domain/message.ts'
import { createRegistry, type Tool } from '../src/domain/tool.ts'
import { NineRouterProvider } from '../src/provider/nineRouter.ts'

function call(id: string, name: string, args = '{}'): ToolCall {
  return { id, type: 'function', function: { name, arguments: args } }
}

async function collect(events: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const output: AgentEvent[] = []
  for await (const event of events) output.push(event)
  return output
}

function scripted(steps: Array<{ message: Message; finishReason?: string }>, seen: Message[][] = []): NineRouterProvider {
  let index = 0
  return {
    model: 'manual-model',
    stream(messages: Message[]) {
      seen.push(messages)
      const step = steps[Math.min(index, steps.length - 1)]
      index += 1
      // eslint-disable-next-line require-yield
      return (async function* response() {
        return { message: step.message, finishReason: step.finishReason ?? (step.message.tool_calls?.length ? 'tool_calls' : 'stop') }
      })()
    },
  } as unknown as NineRouterProvider
}

test('circuit menghitung putaran invalid murni dan tool valid mereset rangkaian', () => {
  const guard = new ToolProtocolCircuitBreaker()
  assert.equal(guard.recordTurn(['invalid-json'], 0).action, 'continue')
  const warning = guard.recordTurn(['invalid-schema', 'unknown-tool'], 0)
  assert.equal(warning.action, 'warning')
  assert.equal(warning.consecutiveTurns, 2)
  assert.equal(warning.failures, 3)
  assert.deepEqual(warning.kinds, ['invalid-json', 'invalid-schema', 'unknown-tool'])

  assert.equal(guard.recordTurn(['invalid-schema'], 1).consecutiveTurns, 0)
  assert.equal(guard.recordTurn(['unknown-tool'], 0).action, 'continue')
  assert.equal(guard.recordTurn(['invalid-json'], 0).action, 'warning')
  assert.equal(guard.recordTurn(['invalid-schema'], 0).action, 'open')
})

test('id tool call kosong dan duplikat dinormalisasi sebelum masuk history', () => {
  const message: Message = {
    role: 'assistant', content: null,
    tool_calls: [call('', 'a'), call('same', 'b'), call('same', 'c')],
  }
  const normalized = normalizeToolCallIds(message, 4)
  const ids = normalized.tool_calls!.map((entry) => entry.id)
  assert.deepEqual(ids, ['call_boo_4_0', 'same', 'call_boo_4_2'])
  assert.equal(new Set(ids).size, ids.length)
  assert.equal(normalizeToolCallIds({ role: 'assistant', content: 'ok' }, 1).content, 'ok')
  assert.equal(toolProtocolName('rusak\u0000\n'.repeat(80)).length <= 100, true)
})

test('mode manual berhenti setelah tiga putaran dengan jenis function call invalid berbeda', async () => {
  const probe: Tool = {
    name: 'probe', description: 'probe', risk: 'safe',
    schema: { type: 'function', function: { name: 'probe', description: 'probe', parameters: {
      type: 'object', properties: { path: { type: 'string' } }, required: ['path'],
    } } },
    preview: () => 'probe',
    async run() { return { content: 'tidak boleh dijalankan' } },
  }
  const seen: Message[][] = []
  const provider = scripted([
    { message: { role: 'assistant', content: null, tool_calls: [call('json', 'probe', '{')] } },
    { message: { role: 'assistant', content: null, tool_calls: [call('schema', 'probe', '{}')] } },
    { message: { role: 'assistant', content: null, tool_calls: [call('unknown', 'missing_tool')] } },
    { message: { role: 'assistant', content: 'tidak boleh sampai' } },
  ], seen)
  const agent = new Agent({
    provider, registry: createRegistry([probe]),
    workspace: mkdtempSync(join(tmpdir(), 'boo-tool-protocol-manual-')),
    askPermission: async () => true, verifyCompletion: false, autoReview: false,
  })
  const events = await collect(agent.send('jalankan probe'))

  assert.equal(seen.length, 3)
  assert.deepEqual(events.filter((event) => event.type === 'tool-invalid').map((event) => event.kind), ['json', 'schema', 'unknown'])
  assert.deepEqual(events.filter((event) => event.type === 'tool-protocol').map((event) => event.stage), ['warning', 'stopped'])
  assert.ok(seen[1].some((message) => message.role === 'system' && message.content?.includes(TOOL_PROTOCOL_GUARD_MARK)))
  assert.equal(agent.history.at(-1)?.content, TOOL_PROTOCOL_STOPPED_REPLY)
  assert.equal((await agent.taskStatus()).outcome, 'stopped')
  assert.equal((await agent.taskStatus()).protocolStops, 1)
  const unanswered = agent.history.flatMap((message) => message.tool_calls ?? []).filter((entry) => !agent.history.some((message) => message.tool_call_id === entry.id))
  assert.deepEqual(unanswered, [])
})

test('tool call valid pada putaran ketiga memulihkan circuit dan dapat selesai', async () => {
  let runs = 0
  const probe: Tool = {
    name: 'probe', description: 'probe', risk: 'safe',
    schema: { type: 'function', function: { name: 'probe', description: 'probe', parameters: { type: 'object', properties: {} } } },
    preview: () => 'probe',
    async run() { runs += 1; return { content: 'ok' } },
  }
  const provider = scripted([
    { message: { role: 'assistant', content: null, tool_calls: [call('one', 'missing_one')] } },
    { message: { role: 'assistant', content: null, tool_calls: [call('two', 'missing_two')] } },
    { message: { role: 'assistant', content: null, tool_calls: [call('valid', 'probe')] } },
    { message: { role: 'assistant', content: 'selesai' } },
  ])
  const agent = new Agent({
    provider, registry: createRegistry([probe]), workspace: mkdtempSync(join(tmpdir(), 'boo-tool-protocol-reset-')),
    askPermission: async () => true, verifyCompletion: false, autoReview: false,
  })
  const events = await collect(agent.send('probe'))

  assert.equal(runs, 1)
  assert.deepEqual(events.filter((event) => event.type === 'tool-protocol').map((event) => event.stage), ['warning'])
  assert.equal(agent.history.at(-1)?.content, 'selesai')
})

test('finish reason tool_calls tanpa call membuka circuit dan berhenti aman', async () => {
  const empty = { message: { role: 'assistant' as const, content: null }, finishReason: 'tool_calls' }
  const provider = scripted([empty])
  const agent = new Agent({
    provider, registry: createRegistry([]), workspace: mkdtempSync(join(tmpdir(), 'boo-tool-protocol-empty-')),
    askPermission: async () => true, verifyCompletion: false, autoReview: false,
  })
  const events = await collect(agent.send('gunakan tool'))
  const stopped = events.find((event): event is Extract<AgentEvent, { type: 'tool-protocol' }> => event.type === 'tool-protocol' && event.stage === 'stopped')
  assert.equal(events.filter((event) => event.type === 'turn-start').length, 3)
  assert.equal(stopped?.failures, 3)
  assert.equal(agent.history.at(-1)?.content, TOOL_PROTOCOL_STOPPED_REPLY)
})

test('mode Auto mengarantina model dengan protokol rusak lalu melanjutkan memakai model cadangan', async () => {
  const ids = ['ag/gemini-3.1-pro', 'cx/gpt-5.6-sol']
  const models: string[] = []
  const provider = new NineRouterProvider({ baseUrl: 'http://unused.invalid', apiKey: 'fake', model: 'ag/gemini-3.1-pro' })
  provider.listModels = async () => ids
  provider.fork = () => {
    const judge = new NineRouterProvider({ baseUrl: 'http://unused.invalid', apiKey: 'fake', model: 'judge' })
    judge.stream = async function* (_messages: Message[], tools: ToolSchema[]) {
      assert.deepEqual(tools, [])
      const content = '{"difficulty":"standard","reason":"Fitur rutin."}'
      yield { type: 'text', delta: content }
      return { message: { role: 'assistant', content }, finishReason: 'stop' }
    }
    return judge
  }
  let brokenCalls = 0
  provider.stream = async function* () {
    models.push(provider.model)
    if (provider.model === 'ag/gemini-3.1-pro') {
      brokenCalls += 1
      return { message: { role: 'assistant', content: null, tool_calls: [call(`bad-${brokenCalls}`, 'missing_tool')] }, finishReason: 'tool_calls' }
    }
    yield { type: 'text', delta: 'selesai dengan fallback' }
    return { message: { role: 'assistant', content: 'selesai dengan fallback' }, finishReason: 'stop' }
  }

  const agent = new Agent({
    provider, modelMode: 'auto', registry: createRegistry([]), workspace: mkdtempSync(join(tmpdir(), 'boo-tool-protocol-auto-')),
    askPermission: async () => true, verifyCompletion: false, autoReview: false,
  })
  const events = await collect(agent.send('buat fitur rutin'))
  const protocol = events.filter((event) => event.type === 'tool-protocol')
  const selected = events.filter((event) => event.type === 'model-selected')

  assert.deepEqual(protocol.map((event) => event.stage), ['warning', 'fallback'])
  assert.deepEqual(selected.map((event) => event.model), ['ag/gemini-3.1-pro', 'cx/gpt-5.6-sol'])
  assert.deepEqual(models, ['ag/gemini-3.1-pro', 'ag/gemini-3.1-pro', 'ag/gemini-3.1-pro', 'cx/gpt-5.6-sol'])
  assert.equal(agent.history.at(-1)?.content, 'selesai dengan fallback')
  assert.equal((await agent.taskStatus()).protocolFallbacks, 1)
})

test('mode Auto membatasi fallback protokol dua kali lalu berhenti', async () => {
  const ids = ['ag/gemini-3.1-pro', 'cx/gpt-5.6-terra', 'cx/gpt-5.6-sol', 'ag/claude-opus-4-6-thinking']
  const models: string[] = []
  const provider = new NineRouterProvider({ baseUrl: 'http://unused.invalid', apiKey: 'fake', model: 'ag/gemini-3.1-pro' })
  provider.listModels = async () => ids
  provider.fork = () => {
    const judge = new NineRouterProvider({ baseUrl: 'http://unused.invalid', apiKey: 'fake', model: 'judge' })
    judge.stream = async function* () {
      const content = '{"difficulty":"standard","reason":"Fitur rutin."}'
      yield { type: 'text', delta: content }
      return { message: { role: 'assistant', content }, finishReason: 'stop' }
    }
    return judge
  }
  let calls = 0
  // eslint-disable-next-line require-yield
  provider.stream = async function* () {
    models.push(provider.model)
    calls += 1
    return { message: { role: 'assistant', content: null, tool_calls: [call(`bad-${calls}`, 'missing_tool')] }, finishReason: 'tool_calls' }
  }
  const agent = new Agent({
    provider, modelMode: 'auto', registry: createRegistry([]), workspace: mkdtempSync(join(tmpdir(), 'boo-tool-protocol-cap-')),
    askPermission: async () => true, verifyCompletion: false, autoReview: false,
  })
  const events = await collect(agent.send('buat fitur rutin'))
  const protocol = events.filter((event) => event.type === 'tool-protocol')

  assert.deepEqual(protocol.map((event) => event.stage), ['warning', 'fallback', 'warning', 'fallback', 'warning', 'stopped'])
  assert.equal(protocol.filter((event) => event.stage === 'fallback').length, 2)
  assert.equal(new Set(models).size, 3)
  assert.equal(models.length, 9)
  assert.equal(agent.history.at(-1)?.content, TOOL_PROTOCOL_STOPPED_REPLY)
  assert.equal((await agent.taskStatus()).protocolStops, 1)
})
