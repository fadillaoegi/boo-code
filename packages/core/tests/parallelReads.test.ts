import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Agent, type AgentEvent } from '../src/agent/loop.ts'
import type { Message, ToolCall } from '../src/domain/message.ts'
import { createRegistry, type Tool } from '../src/domain/tool.ts'
import type { NineRouterProvider } from '../src/provider/nineRouter.ts'
import { defaultTools } from '../src/tools/index.ts'

function call(id: string, path: string, extra: Record<string, unknown> = {}): ToolCall {
  return { id, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path, ...extra }) } }
}

function discoveryCall(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}

function scripted(steps: Message[]): NineRouterProvider {
  let index = 0
  return {
    model: 'palsu',
    stream() {
      const message = steps[Math.min(index, steps.length - 1)]
      index += 1
      // eslint-disable-next-line require-yield
      return (async function* reply() { return { finishReason: message.tool_calls?.length ? 'tool_calls' : 'stop', message } })()
    },
  } as unknown as NineRouterProvider
}

function readTool(run: (path: string) => Promise<string>): Tool {
  return {
    name: 'read_file', description: 'read', risk: 'safe',
    parallelSafe: true,
    schema: { type: 'function', function: { name: 'read_file', description: 'read', parameters: {
      type: 'object', properties: { path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } }, required: ['path'],
    } } },
    preview: (args) => `baca ${String((args as { path?: unknown }).path)}`,
    async run(args) { return { content: await run(String((args as { path?: unknown }).path)) } },
  }
}

test('hanya tool discovery lokal yang diaudit yang opt-in ke scheduler', () => {
  assert.deepEqual(defaultTools.filter((tool) => tool.parallelSafe).map((tool) => tool.name).sort(), [
    'git_blame', 'git_changed_files', 'git_diff', 'git_log', 'git_show', 'git_status', 'grep', 'read_file', 'read_tool_output', 'repo_map',
  ])
})

test('read_file independen berjalan bersamaan tetapi hasil masuk history dalam urutan call', { timeout: 2_000 }, async () => {
  let active = 0
  let maximumActive = 0
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => { release = resolve })
  const tool = readTool(async (path) => {
    active += 1
    maximumActive = Math.max(maximumActive, active)
    if (active === 2) release?.()
    await gate
    active -= 1
    return `isi ${path}`
  })
  const agent = new Agent({
    provider: scripted([
      { role: 'assistant', content: null, tool_calls: [call('one', 'a.ts'), call('two', 'b.ts')] },
      { role: 'assistant', content: 'selesai' },
    ]),
    registry: createRegistry([tool]), workspace: mkdtempSync(join(tmpdir(), 'boo-parallel-read-')), askPermission: async () => true,
  })
  const events: AgentEvent[] = []
  for await (const event of agent.send('baca dua file')) events.push(event)

  assert.equal(maximumActive, 2)
  assert.deepEqual(events.filter((event) => event.type === 'tool-parallel').map((event) => [event.stage, event.calls]), [
    ['started', 2], ['completed', 2],
  ])
  assert.deepEqual(agent.history.filter((message) => message.role === 'tool').map((message) => message.tool_call_id), ['one', 'two'])
  assert.deepEqual(agent.history.filter((message) => message.role === 'tool').map((message) => message.content), ['isi a.ts', 'isi b.ts'])
  const status = await agent.taskStatus()
  assert.equal(status.parallelDiscoveryBatches, 1)
  assert.equal(status.parallelDiscoveryCalls, 2)
})

test('tool discovery opt-in yang heterogen berjalan bersama dan selesai sesuai urutan call', { timeout: 2_000 }, async () => {
  let active = 0
  let maximumActive = 0
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => { release = resolve })
  const makeTool = (name: string): Tool => ({
    name, description: name, risk: 'safe', parallelSafe: true,
    schema: { type: 'function', function: { name, description: name, parameters: {
      type: 'object', properties: { query: { type: 'string' } }, required: ['query'],
    } } },
    preview: (args) => `${name} ${String((args as { query?: unknown }).query)}`,
    async run(args) {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      if (active === 3) release?.()
      await gate
      active -= 1
      return { content: `${name}:${String((args as { query?: unknown }).query)}` }
    },
  })
  const calls = [
    discoveryCall('grep', 'grep', { query: 'router' }),
    discoveryCall('map', 'repo_map', { query: 'agent' }),
    discoveryCall('git', 'git_status', { query: 'tree' }),
  ]
  const agent = new Agent({
    provider: scripted([{ role: 'assistant', content: null, tool_calls: calls }, { role: 'assistant', content: 'selesai' }]),
    registry: createRegistry([makeTool('grep'), makeTool('repo_map'), makeTool('git_status')]),
    workspace: mkdtempSync(join(tmpdir(), 'boo-parallel-discovery-')), askPermission: async () => true,
  })
  const events: AgentEvent[] = []
  for await (const event of agent.send('jelajahi repo')) events.push(event)

  assert.equal(maximumActive, 3)
  assert.deepEqual(events.filter((event): event is Extract<AgentEvent, { type: 'tool-parallel' }> => event.type === 'tool-parallel').map((event) => [event.stage, event.tools]), [
    ['started', ['grep', 'repo_map', 'git_status']],
    ['completed', ['grep', 'repo_map', 'git_status']],
  ])
  assert.deepEqual(agent.history.filter((message) => message.role === 'tool').map((message) => message.tool_call_id), ['grep', 'map', 'git'])
})

test('scheduler membatasi concurrency empat dan membagi batch berikutnya', async () => {
  let active = 0
  let maximumActive = 0
  const tool = readTool(async (path) => {
    active += 1
    maximumActive = Math.max(maximumActive, active)
    await new Promise((resolve) => setTimeout(resolve, 15))
    active -= 1
    return path
  })
  const calls = Array.from({ length: 6 }, (_, index) => call(`call-${index}`, `${index}.ts`))
  const agent = new Agent({
    provider: scripted([{ role: 'assistant', content: null, tool_calls: calls }, { role: 'assistant', content: 'selesai' }]),
    registry: createRegistry([tool]), workspace: mkdtempSync(join(tmpdir(), 'boo-parallel-limit-')), askPermission: async () => true,
  })
  const events: AgentEvent[] = []
  for await (const event of agent.send('baca enam file')) events.push(event)

  assert.equal(maximumActive, 4)
  assert.deepEqual(events.filter((event): event is Extract<AgentEvent, { type: 'tool-parallel' }> => event.type === 'tool-parallel' && event.stage === 'started').map((event) => event.calls), [4, 2])
  assert.deepEqual(agent.history.filter((message) => message.role === 'tool').map((message) => message.tool_call_id), calls.map((item) => item.id))
})

test('hasil batch masuk evidence cache dan panggilan batch identik berikutnya tidak membaca ulang', async () => {
  let runs = 0
  const tool = readTool(async (path) => { runs += 1; return `isi panjang ${path} ${'x'.repeat(500)}` })
  const pair = (prefix: string) => [call(`${prefix}-a`, 'a.ts'), call(`${prefix}-b`, 'b.ts')]
  const agent = new Agent({
    provider: scripted([
      { role: 'assistant', content: null, tool_calls: pair('first') },
      { role: 'assistant', content: null, tool_calls: pair('second') },
      { role: 'assistant', content: 'selesai' },
    ]),
    registry: createRegistry([tool]), workspace: mkdtempSync(join(tmpdir(), 'boo-parallel-cache-')), askPermission: async () => true,
  })
  const events: AgentEvent[] = []
  for await (const event of agent.send('baca ulang dua file')) events.push(event)

  assert.equal(runs, 2)
  assert.equal(events.filter((event) => event.type === 'tool-cache-hit').length, 2)
  assert.equal(events.filter((event) => event.type === 'tool-parallel' && event.stage === 'started').length, 1)
})

test('argumen invalid dan lifecycle hook membuat scheduler kembali ke jalur serial aman', async () => {
  let runs = 0
  const tool = readTool(async (path) => { runs += 1; return path })
  const invalid: ToolCall = { id: 'invalid', type: 'function', function: { name: 'read_file', arguments: '{}' } }
  const agent = new Agent({
    provider: scripted([
      { role: 'assistant', content: null, tool_calls: [call('valid', 'a.ts'), invalid] },
      { role: 'assistant', content: 'selesai' },
    ]),
    registry: createRegistry([tool]), workspace: mkdtempSync(join(tmpdir(), 'boo-parallel-invalid-')), askPermission: async () => true,
  })
  const events: AgentEvent[] = []
  for await (const event of agent.send('baca')) events.push(event)
  assert.equal(runs, 1)
  assert.equal(events.some((event) => event.type === 'tool-parallel'), false)
  assert.equal(events.some((event) => event.type === 'tool-invalid'), true)

  const blocked = new Agent({
    provider: scripted([
      { role: 'assistant', content: null, tool_calls: [call('a', 'a.ts'), call('b', 'b.ts')] },
      { role: 'assistant', content: 'selesai' },
    ]),
    registry: createRegistry([tool]), workspace: mkdtempSync(join(tmpdir(), 'boo-parallel-hook-')), askPermission: async () => false,
    hooks: () => [{
      id: 'policy', event: 'before_tool', matcher: 'read_file', command: 'true', timeoutSeconds: 5,
      mutatesWorkspace: false, verifiesWorkspace: false, source: 'project', label: '.boo/hooks.json',
    }],
  })
  const blockedEvents: AgentEvent[] = []
  for await (const event of blocked.send('baca')) blockedEvents.push(event)
  assert.equal(blockedEvents.some((event) => event.type === 'tool-parallel'), false)
})

test('risk safe tanpa parallelSafe tetap memakai jalur serial', async () => {
  let active = 0
  let maximumActive = 0
  const tool = readTool(async (path) => {
    active += 1
    maximumActive = Math.max(maximumActive, active)
    await new Promise((resolve) => setTimeout(resolve, 10))
    active -= 1
    return path
  })
  delete tool.parallelSafe
  const agent = new Agent({
    provider: scripted([
      { role: 'assistant', content: null, tool_calls: [call('a', 'a.ts'), call('b', 'b.ts')] },
      { role: 'assistant', content: 'selesai' },
    ]),
    registry: createRegistry([tool]), workspace: mkdtempSync(join(tmpdir(), 'boo-parallel-opt-in-')), askPermission: async () => true,
  })
  const events: AgentEvent[] = []
  for await (const event of agent.send('baca')) events.push(event)
  assert.equal(maximumActive, 1)
  assert.equal(events.some((event) => event.type === 'tool-parallel'), false)
})
