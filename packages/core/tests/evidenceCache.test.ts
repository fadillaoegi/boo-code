import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EvidenceCache, EVIDENCE_CACHE_MARK } from '../src/agent/evidenceCache.ts'
import { Agent, type AgentEvent } from '../src/agent/loop.ts'
import type { Message, ToolCall } from '../src/domain/message.ts'
import { createRegistry, type Tool } from '../src/domain/tool.ts'
import type { NineRouterProvider } from '../src/provider/nineRouter.ts'
import { UNTRUSTED_DATA_MARK } from '../src/security/promptInjection.ts'
import { readFileTool } from '../src/tools/readFile.ts'

function call(id: string, name: string, args: object): ToolCall {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
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

function readTool(run: () => string): Tool<{ path: string; offset?: number }> {
  return {
    name: 'read_file', description: 'read', risk: 'safe',
    schema: {
      type: 'function',
      function: {
        name: 'read_file', description: 'read',
        parameters: {
          type: 'object', properties: { path: { type: 'string' }, offset: { type: 'number' } }, required: ['path'],
        },
      },
    },
    preview: (args) => `baca ${args.path}`,
    async run() { return { content: run() } },
  }
}

test('cache memakai signature argumen canonical, reference opaque, dan invalidasi eksplisit', () => {
  const cache = new EvidenceCache()
  const ref = cache.store('read_file', { path: 'src/a.ts', offset: 1 }, 'source', 'baca src/a.ts', 'isi panjang')
  assert.match(ref ?? '', /^[a-f0-9]{16}$/)

  const hit = cache.lookup('read_file', { offset: 1, path: 'src/a.ts' })
  assert.equal(hit?.ref, ref)
  assert.match(hit?.content ?? '', /BOO EVIDENCE CACHE REF:/)
  assert.equal(cache.lookup('grep', { pattern: 'x' }), null, 'tool tanpa dependency eksak tidak di-cache')

  cache.invalidate()
  assert.equal(cache.lookup('read_file', { path: 'src/a.ts', offset: 1 }), null)
})

test('reference hanya dihidrasi bila hasil sumber sudah tidak ada dalam context', () => {
  const cache = new EvidenceCache()
  const ref = cache.store('read_file', { path: 'a.ts' }, 'source', 'baca a.ts', '1\tconst answer = 42')!
  assert.equal(EVIDENCE_CACHE_MARK, '[BOO EVIDENCE CACHE]')
  const marker = `[BOO EVIDENCE CACHE REF:${ref}]\nreuse`
  const retained = cache.hydrateReferences([
    { role: 'tool', tool_call_id: 'source', content: 'hasil asli masih ada' },
    { role: 'tool', tool_call_id: 'repeat', content: marker },
  ])
  assert.equal(retained.hydrated, 0)
  assert.equal(retained.messages[1].content, marker)

  const restored = cache.hydrateReferences([{ role: 'tool', tool_call_id: 'repeat', content: marker }])
  assert.equal(restored.hydrated, 1)
  assert.equal(restored.messages[0].content?.includes(UNTRUSTED_DATA_MARK), true)
  assert.match(restored.messages[0].content ?? '', /const answer = 42/)
})

test('Agent mengeksekusi read_file identik sekali lalu memakai cache tanpa memicu loop guard', async () => {
  let runs = 0
  const content = 'x'.repeat(2_000)
  const events: AgentEvent[] = []
  const agent = new Agent({
    provider: scripted([
      { role: 'assistant', content: null, tool_calls: [call('one', 'read_file', { path: 'a.ts' })] },
      { role: 'assistant', content: null, tool_calls: [call('two', 'read_file', { path: 'a.ts' })] },
      { role: 'assistant', content: 'selesai' },
    ]),
    registry: createRegistry([readTool(() => { runs += 1; return content })]),
    workspace: mkdtempSync(join(tmpdir(), 'boo-evidence-cache-')),
    askPermission: async () => true,
  })
  for await (const event of agent.send('baca dua kali')) events.push(event)

  assert.equal(runs, 1)
  const hit = events.find((event): event is Extract<AgentEvent, { type: 'tool-cache-hit' }> => event.type === 'tool-cache-hit')
  assert.equal(hit?.name, 'read_file')
  assert.ok((hit?.savedCharacters ?? 0) > 1_000)
  assert.equal(events.some((event) => event.type === 'tool-loop'), false)
  assert.match(agent.history.find((message) => message.role === 'tool' && message.tool_call_id === 'two')?.content ?? '', /BOO EVIDENCE CACHE REF:/)
  const status = await agent.taskStatus()
  assert.equal(status.evidenceCacheHits, 1)
  assert.equal(status.tools.completed, 2)
})

test('mutasi workspace menginvalidasi cache sebelum pembacaan berikutnya', async () => {
  let reads = 0
  let value = 'awal'
  const mutate: Tool = {
    name: 'mutate', description: 'mutate', risk: 'confirm', writesWorkspace: true, mutatesWorkspace: true,
    schema: { type: 'function', function: { name: 'mutate', description: 'mutate', parameters: { type: 'object', properties: {} } } },
    preview: () => 'ubah',
    async run() { value = 'baru'; return { content: 'diubah' } },
  }
  const events: AgentEvent[] = []
  const agent = new Agent({
    provider: scripted([
      { role: 'assistant', content: null, tool_calls: [call('one', 'read_file', { path: 'a.ts' })] },
      { role: 'assistant', content: null, tool_calls: [call('write', 'mutate', {})] },
      { role: 'assistant', content: null, tool_calls: [call('two', 'read_file', { path: 'a.ts' })] },
      { role: 'assistant', content: 'selesai' },
    ]),
    registry: createRegistry([readTool(() => { reads += 1; return value }), mutate]),
    workspace: mkdtempSync(join(tmpdir(), 'boo-evidence-invalidate-')),
    askPermission: async () => true,
    verifyCompletion: false,
  })
  for await (const event of agent.send('baca, ubah, baca')) events.push(event)

  assert.equal(reads, 2)
  assert.equal(events.some((event) => event.type === 'tool-cache-hit'), false)
  assert.equal(agent.history.find((message) => message.role === 'tool' && message.tool_call_id === 'two')?.content, 'baru')
})

test('perubahan eksternal setelah awal turn membatalkan cache hit dan membaca isi terbaru', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'boo-evidence-external-'))
  const path = join(workspace, 'a.ts')
  writeFileSync(path, 'awal\n')
  let turn = 0
  const provider = {
    model: 'palsu',
    stream() {
      turn += 1
      if (turn === 2) writeFileSync(path, 'baru dari editor\n')
      const message: Message = turn === 1
        ? { role: 'assistant', content: null, tool_calls: [call('one', 'read_file', { path: 'a.ts' })] }
        : turn === 2
          ? { role: 'assistant', content: null, tool_calls: [call('two', 'read_file', { path: 'a.ts' })] }
          : { role: 'assistant', content: 'selesai' }
      // eslint-disable-next-line require-yield
      return (async function* reply() { return { finishReason: message.tool_calls?.length ? 'tool_calls' : 'stop', message } })()
    },
  } as unknown as NineRouterProvider
  const agent = new Agent({ provider, registry: createRegistry([readFileTool as unknown as Tool]), workspace, askPermission: async () => true })
  const events: AgentEvent[] = []
  for await (const event of agent.send('baca lalu baca ulang')) events.push(event)

  assert.equal(events.some((event) => event.type === 'tool-cache-hit'), false)
  assert.equal(events.some((event) => event.type === 'workspace-changed'), true)
  assert.match(agent.history.find((message) => message.role === 'tool' && message.tool_call_id === 'two')?.content ?? '', /baru dari editor/)
})

test('cache tidak melewati lifecycle hook yang cocok', async () => {
  let reads = 0
  const agent = new Agent({
    provider: scripted([
      { role: 'assistant', content: null, tool_calls: [call('one', 'read_file', { path: 'a.ts' })] },
      { role: 'assistant', content: null, tool_calls: [call('two', 'read_file', { path: 'a.ts' })] },
      { role: 'assistant', content: 'selesai' },
    ]),
    registry: createRegistry([readTool(() => { reads += 1; return `hasil ${reads}` })]),
    workspace: mkdtempSync(join(tmpdir(), 'boo-evidence-hooks-')),
    askPermission: async () => false,
    hooks: () => [{
      id: 'policy', event: 'before_tool', matcher: 'read_file', command: 'true', timeoutSeconds: 5,
      mutatesWorkspace: false, verifiesWorkspace: false, source: 'project', label: '.boo/hooks.json',
    }],
  })
  const events: AgentEvent[] = []
  for await (const event of agent.send('baca dua kali')) events.push(event)

  assert.equal(reads, 0, 'hook ditolak sehingga tool tidak dijalankan')
  assert.equal(events.some((event) => event.type === 'tool-cache-hit'), false)
})
