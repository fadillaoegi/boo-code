import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Agent, type AgentEvent } from '../src/agent/loop.ts'
import { ToolLoopGuard, TOOL_LOOP_GUARD_MARK, TOOL_LOOP_STOPPED_REPLY } from '../src/agent/stall.ts'
import type { Message, ToolCall } from '../src/domain/message.ts'
import { createRegistry, type Tool } from '../src/domain/tool.ts'
import type { NineRouterProvider } from '../src/provider/nineRouter.ts'

function call(id: string, args: object): ToolCall {
  return { id, type: 'function', function: { name: 'probe', arguments: JSON.stringify(args) } }
}

function scripted(steps: Message[], seen: Message[][] = []): NineRouterProvider {
  let index = 0
  return {
    model: 'palsu',
    stream(messages: Message[]) {
      seen.push(messages.map((message) => ({ ...message })))
      const message = steps[Math.min(index, steps.length - 1)]
      index += 1
      // eslint-disable-next-line require-yield
      return (async function* reply() {
        return { finishReason: message.tool_calls?.length ? 'tool_calls' : 'stop', message }
      })()
    },
  } as unknown as NineRouterProvider
}

test('guard menormalkan urutan key, memperingatkan, memblokir, lalu menghentikan', () => {
  const guard = new ToolLoopGuard()
  const first = guard.inspect('read_file', { path: 'a', offset: 1 })
  assert.equal(first.action, 'allow')
  assert.equal(guard.record(first.token, 'hasil sama', 'failed'), false)
  const second = guard.inspect('read_file', { offset: 1, path: 'a' })
  assert.equal(second.action, 'allow', 'urutan property JSON tidak mengubah signature')
  assert.equal(guard.record(second.token, 'hasil sama', 'failed'), true)
  assert.equal(guard.inspect('read_file', { path: 'a', offset: 1 }).action, 'blocked')
  assert.equal(guard.inspect('read_file', { path: 'a', offset: 1 }).action, 'stopped')
})

test('hasil berubah, argumen berubah, dan polling bash_output tidak dianggap stagnan', () => {
  const guard = new ToolLoopGuard()
  let decision = guard.inspect('grep', { pattern: 'a' })
  guard.record(decision.token, 'hasil 1', 'completed')
  decision = guard.inspect('grep', { pattern: 'a' })
  assert.equal(guard.record(decision.token, 'hasil 2', 'completed'), false)
  assert.equal(guard.inspect('grep', { pattern: 'b' }).action, 'allow')

  for (let index = 0; index < 10; index += 1) {
    const poll = guard.inspect('bash_output', { id: 'server' })
    assert.equal(poll.action, 'allow')
    assert.equal(poll.token, null)
  }
})

test('Agent menjalankan side effect maksimal dua kali dan history tetap sah setelah loop dihentikan', async () => {
  let runs = 0
  const seen: Message[][] = []
  const probe: Tool = {
    name: 'probe', description: 'probe', risk: 'safe', mutatesWorkspace: true,
    schema: { type: 'function', function: { name: 'probe', description: 'probe', parameters: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] } } },
    preview: () => 'probe',
    async run() { runs += 1; return { content: 'hasil identik', isError: true } },
  }
  const provider = scripted([
    { role: 'assistant', content: null, tool_calls: [call('one', { value: 1 })] },
    { role: 'assistant', content: null, tool_calls: [call('two', { value: 1 })] },
    { role: 'assistant', content: null, tool_calls: [call('three', { value: 1 })] },
    { role: 'assistant', content: null, tool_calls: [call('four', { value: 1 })] },
    { role: 'assistant', content: 'Pendekatan diganti.' },
  ], seen)
  const agent = new Agent({
    provider, registry: createRegistry([probe]),
    workspace: mkdtempSync(join(tmpdir(), 'boo-stall-')),
    askPermission: async () => true,
  })
  const events: AgentEvent[] = []
  for await (const event of agent.send('jalankan probe')) events.push(event)

  assert.equal(runs, 2)
  assert.deepEqual(events.filter((event) => event.type === 'tool-loop').map((event) => event.stage), ['warning', 'blocked', 'stopped'])
  assert.match(agent.history.at(-1)?.content ?? '', /loop guard/i)
  assert.ok(agent.history.some((message) => message.role === 'tool' && message.content?.includes(TOOL_LOOP_GUARD_MARK)))
  assert.ok(seen[2].some((message) => message.role === 'system' && message.content?.includes(TOOL_LOOP_GUARD_MARK)), 'peringatan dikirim sebagai system prompt trusted')
  assert.ok(seen[3].some((message) => message.role === 'system' && /blocked another identical invocation/.test(message.content ?? '')))
  assert.equal((await agent.taskStatus()).outcome, 'incomplete')
  assert.equal((await agent.taskStatus()).loopBlocks, 2)

  const continued: AgentEvent[] = []
  for await (const event of agent.send('gunakan pendekatan lain')) continued.push(event)
  assert.equal(agent.history.at(-1)?.content, 'Pendekatan diganti.')
  assert.ok(!continued.some((event) => event.type === 'tool-loop'))
  assert.equal(TOOL_LOOP_STOPPED_REPLY.includes('dihentikan'), true)
})

test('panggilan berbeda setelah peringatan dianggap kemajuan dan tidak diblokir', async () => {
  let runs = 0
  const probe: Tool = {
    name: 'probe', description: 'probe', risk: 'safe',
    schema: { type: 'function', function: { name: 'probe', description: 'probe', parameters: { type: 'object', properties: { value: { type: 'number' } } } } },
    preview: () => 'probe', async run(args) { runs += 1; return { content: `hasil ${String((args as { value?: number }).value && 'sama')}` } },
  }
  const agent = new Agent({
    provider: scripted([
      { role: 'assistant', content: null, tool_calls: [call('one', { value: 1 })] },
      { role: 'assistant', content: null, tool_calls: [call('two', { value: 1 })] },
      { role: 'assistant', content: null, tool_calls: [call('three', { value: 2 })] },
      { role: 'assistant', content: 'selesai' },
    ]),
    registry: createRegistry([probe]), workspace: mkdtempSync(join(tmpdir(), 'boo-stall-progress-')), askPermission: async () => true,
  })
  const events: AgentEvent[] = []
  for await (const event of agent.send('probe berbeda')) events.push(event)
  assert.equal(runs, 3)
  assert.deepEqual(events.filter((event) => event.type === 'tool-loop').map((event) => event.stage), ['warning'])
  assert.equal(agent.history.at(-1)?.content, 'selesai')
})

test('penolakan pengguna tidak diminta ulang untuk panggilan identik', async () => {
  let permissions = 0
  let runs = 0
  const probe: Tool = {
    name: 'probe', description: 'probe', risk: 'confirm',
    schema: { type: 'function', function: { name: 'probe', description: 'probe', parameters: { type: 'object', properties: {} } } },
    preview: () => 'probe', async run() { runs += 1; return { content: 'seharusnya tidak berjalan' } },
  }
  const seen: Message[][] = []
  const agent = new Agent({
    provider: scripted([
      { role: 'assistant', content: null, tool_calls: [call('one', {})] },
      { role: 'assistant', content: null, tool_calls: [call('two', {})] },
      { role: 'assistant', content: null, tool_calls: [call('three', {})] },
    ], seen),
    registry: createRegistry([probe]), workspace: mkdtempSync(join(tmpdir(), 'boo-stall-denied-')),
    askPermission: async () => { permissions += 1; return false },
  })
  const events: AgentEvent[] = []
  for await (const event of agent.send('probe')) events.push(event)

  assert.equal(permissions, 1)
  assert.equal(runs, 0)
  assert.deepEqual(events.filter((event) => event.type === 'tool-loop').map((event) => [event.stage, event.repetitions]), [
    ['warning', 1], ['blocked', 3], ['stopped', 4],
  ])
  assert.ok(seen[1].some((message) => message.role === 'system' && /user denying/.test(message.content ?? '')))
})
