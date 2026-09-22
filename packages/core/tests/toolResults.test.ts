import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Agent, type AgentEvent } from '../src/agent/loop.ts'
import type { Message } from '../src/domain/message.ts'
import { createRegistry, type Tool } from '../src/domain/tool.ts'
import type { NineRouterProvider } from '../src/provider/nineRouter.ts'
import {
  MAX_STORED_TOOL_RESULT_CHARACTERS,
  MAX_VISIBLE_TOOL_RESULT_CHARACTERS,
  TOOL_RESULT_TRUNCATED_MARK,
  ToolResultStore,
} from '../src/agent/toolResults.ts'
import { readToolOutputTool } from '../src/tools/toolOutput.ts'

test('hasil kecil tetap utuh dan hasil besar dapat dibaca ulang per bagian', () => {
  const store = new ToolResultStore()
  assert.deepEqual(store.present('small', 'one', 'isi'), {
    content: 'isi', truncated: false, originalCharacters: 3, visibleCharacters: 3,
  })

  const source = `${'a'.repeat(70_000)}TOKEN_TENGAH${'z'.repeat(30_000)}`
  const presented = store.present('dump', 'two', source)
  assert.equal(presented.truncated, true)
  assert.ok(presented.ref)
  assert.ok(presented.content.length <= MAX_VISIBLE_TOOL_RESULT_CHARACTERS)
  assert.ok(presented.content.includes(TOOL_RESULT_TRUNCATED_MARK))
  assert.doesNotMatch(presented.content, /TOKEN_TENGAH/)

  const page = store.read(presented.ref!, 65_000, 10_000)
  assert.equal(page.isError, undefined)
  assert.match(page.content, /TOKEN_TENGAH/)
  assert.match(page.content, /Karakter 65000/)
  assert.equal(store.read('tidak-valid').isError, true)
  assert.equal(store.read(presented.ref!, source.length + 1).isError, true)
})

test('hasil di atas batas per-entry dipadatkan tanpa reference palsu', () => {
  const store = new ToolResultStore()
  const presented = store.present('huge', 'one', 'x'.repeat(MAX_STORED_TOOL_RESULT_CHARACTERS + 1))
  assert.equal(presented.truncated, true)
  assert.equal(presented.ref, undefined)
  assert.match(presented.content, /bagian tengah tidak tersedia/)
})

test('Agent menyimpan output besar, lalu read_tool_output mengambil bagian yang hilang', async () => {
  const source = `${'a'.repeat(70_000)}TOKEN_TENGAH${'z'.repeat(30_000)}`
  const dumpTool: Tool = {
    name: 'dump', description: 'dump', risk: 'safe',
    schema: { type: 'function', function: { name: 'dump', description: 'dump', parameters: { type: 'object', properties: {} } } },
    preview: () => 'hasilkan output besar',
    async run() { return { content: source } },
  }
  let turn = 0
  const provider = {
    model: 'palsu',
    stream(messages: Message[]) {
      turn += 1
      // eslint-disable-next-line require-yield
      return (async function* reply() {
        if (turn === 1) {
          const message: Message = { role: 'assistant', content: null, tool_calls: [{ id: 'dump-call', type: 'function', function: { name: 'dump', arguments: '{}' } }] }
          return { finishReason: 'tool_calls', message }
        }
        if (turn === 2) {
          const truncated = [...messages].reverse().find((message) => message.role === 'tool')?.content ?? ''
          const ref = /\b[a-f0-9]{16}\b/.exec(truncated)?.[0]
          assert.ok(ref)
          const message: Message = { role: 'assistant', content: null, tool_calls: [{
            id: 'page-call', type: 'function', function: { name: 'read_tool_output', arguments: JSON.stringify({ ref, offset: 65_000, limit: 10_000 }) },
          }] }
          return { finishReason: 'tool_calls', message }
        }
        const page = [...messages].reverse().find((message) => message.role === 'tool')?.content ?? ''
        assert.match(page, /TOKEN_TENGAH/)
        return { finishReason: 'stop', message: { role: 'assistant', content: 'selesai' } as Message }
      })()
    },
  } as unknown as NineRouterProvider
  const agent = new Agent({
    provider, registry: createRegistry([dumpTool, readToolOutputTool]),
    workspace: mkdtempSync(join(tmpdir(), 'boo-tool-result-')), askPermission: async () => true,
  })
  const events: AgentEvent[] = []
  for await (const event of agent.send('periksa output besar')) events.push(event)

  const truncated = events.filter((event): event is Extract<AgentEvent, { type: 'tool-result-truncated' }> => event.type === 'tool-result-truncated')
  assert.equal(truncated.length, 1)
  assert.equal(truncated[0].name, 'dump')
  assert.ok(truncated[0].ref)
  const results = agent.history.filter((message) => message.role === 'tool')
  assert.ok((results[0].content ?? '').includes(TOOL_RESULT_TRUNCATED_MARK))
  assert.doesNotMatch(results[0].content ?? '', /TOKEN_TENGAH/)
  assert.match(results[1].content ?? '', /TOKEN_TENGAH/)
  const status = await agent.taskStatus()
  assert.equal(status.truncatedToolResults, 1)
  assert.ok(status.deferredToolResultCharacters > 0)
})
