import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Agent } from '../src/agent/loop.ts'
import type { Message, ToolCall, ToolSchema } from '../src/domain/message.ts'
import { createRegistry, type Tool } from '../src/domain/tool.ts'
import type { NineRouterProvider } from '../src/provider/nineRouter.ts'
import { createReviewRegistry } from '../src/agent/review.ts'
import { estimateToolSchemaTokens } from '../src/agent/context.ts'
import { createDefaultRegistry, defaultTools } from '../src/tools/index.ts'
import { createDiscoverableRegistry } from '../src/tools/toolSearch.ts'

function call(id: string, name: string, args: object): ToolCall {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}

test('registry default hanya mengekspos tool inti dan katalog pencarian', () => {
  const registry = createDefaultRegistry()
  const all = registry.list().map((tool) => tool.name)
  const active = registry.schemas().map((schema) => schema.function.name)

  assert.ok(all.includes('browser_click'))
  assert.ok(all.includes('git_blame'))
  assert.ok(active.includes('tool_search'))
  assert.ok(active.includes('read_file'))
  assert.ok(active.includes('apply_patch'))
  assert.ok(!active.includes('browser_click'))
  assert.ok(!active.includes('git_blame'))
  assert.ok(active.length < all.length / 2)

  const staticTokens = estimateToolSchemaTokens(createRegistry(defaultTools as never).schemas())
  assert.ok(estimateToolSchemaTokens(registry.schemas()) < staticTokens / 2)
})

test('pencarian mengaktifkan hasil relevan secara deterministik dan reset per task', async () => {
  const registry = createDefaultRegistry()
  const search = registry.get('tool_search')!
  const result = await search.run({ query: 'whatsapp kirim pesan', max_results: 4 }, { workspace: '/unused' })

  assert.equal(result.isError, undefined)
  assert.match(result.content, /whatsapp_send_message/)
  assert.ok(registry.schemas().some((schema) => schema.function.name === 'whatsapp_send_message'))
  assert.ok(!registry.schemas().some((schema) => schema.function.name === 'browser_click'))

  registry.beginTask?.()
  assert.ok(!registry.schemas().some((schema) => schema.function.name === 'whatsapp_send_message'))
  assert.ok(registry.schemas().some((schema) => schema.function.name === 'tool_search'))
})

test('agent menerima skema baru pada putaran setelah tool_search', async () => {
  const probe: Tool = {
    name: 'dependency_probe',
    description: 'Inspect a dependency graph for cycles and ownership.',
    risk: 'safe',
    schema: {
      type: 'function',
      function: {
        name: 'dependency_probe',
        description: 'Inspect a dependency graph for cycles and ownership.',
        parameters: { type: 'object', properties: {} },
      },
    },
    preview: () => 'inspect dependencies',
    async run() { return { content: 'dependency graph clean' } },
  }
  const registry = createDiscoverableRegistry([probe], { alwaysAvailable: [] })
  const seen: string[][] = []
  let turn = 0
  const provider = {
    model: 'test-model',
    stream(_messages: Message[], tools: ToolSchema[]) {
      seen.push(tools.map((tool) => tool.function.name))
      turn += 1
      // eslint-disable-next-line require-yield
      return (async function* response() {
        if (turn === 1) return { finishReason: 'tool_calls', message: { role: 'assistant' as const, content: null, tool_calls: [call('search', 'tool_search', { query: 'dependency graph' })] } }
        if (turn === 2) return { finishReason: 'tool_calls', message: { role: 'assistant' as const, content: null, tool_calls: [call('probe', 'dependency_probe', {})] } }
        return { finishReason: 'stop', message: { role: 'assistant' as const, content: 'Selesai.' } }
      })()
    },
  } as unknown as NineRouterProvider

  const agent = new Agent({
    provider,
    registry,
    workspace: mkdtempSync(join(tmpdir(), 'boo-tool-search-')),
    askPermission: async () => true,
    verifyCompletion: false,
    autoReview: false,
  })
  for await (const event of agent.send('periksa dependency graph')) void event

  assert.deepEqual(seen[0], ['tool_search'])
  assert.ok(seen[1].includes('dependency_probe'))
  assert.ok(seen[2].includes('dependency_probe'))
})

test('katalog review tidak dapat menemukan tool mutasi atau eksternal', async () => {
  const registry = createReviewRegistry(createDefaultRegistry())
  const search = registry.get('tool_search')!
  const result = await search.run({ query: 'write edit browser external message', max_results: 12 }, { workspace: '/unused' })
  const all = registry.list().map((tool) => tool.name)

  assert.ok(!all.includes('write_file'))
  assert.ok(!all.includes('browser_click'))
  assert.ok(!all.includes('whatsapp_send_message'))
  assert.doesNotMatch(result.content, /write_file|browser_click|whatsapp_send_message/)
})

test('query kosong dan terlalu panjang ditolak tanpa mengaktifkan tool', async () => {
  const registry = createDefaultRegistry()
  const before = registry.schemas().map((schema) => schema.function.name)
  const empty = await registry.get('tool_search')!.run({ query: '   ' }, { workspace: '/unused' })
  const long = await registry.get('tool_search')!.run({ query: 'x'.repeat(201) }, { workspace: '/unused' })

  assert.equal(empty.isError, true)
  assert.equal(long.isError, true)
  assert.deepEqual(registry.schemas().map((schema) => schema.function.name), before)
})
