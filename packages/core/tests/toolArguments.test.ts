import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Agent, type AgentEvent } from '../src/agent/loop.ts'
import { TOOL_ARGUMENT_GUARD_MARK, validateToolArguments } from '../src/agent/toolArguments.ts'
import type { Message, ToolCall, ToolSchema } from '../src/domain/message.ts'
import { createRegistry, type Tool } from '../src/domain/tool.ts'
import type { NineRouterProvider } from '../src/provider/nineRouter.ts'

const parameters: ToolSchema['function']['parameters'] = {
  type: 'object',
  properties: {
    path: { type: 'string', pattern: '\\.ts$' },
    count: { type: 'integer', minimum: 1, maximum: 3 },
    mode: { type: 'string', enum: ['read', 'write'] },
    entries: {
      type: 'array', minItems: 1, maxItems: 2,
      items: {
        type: 'object', properties: { label: { type: 'string' } },
        required: ['label'], additionalProperties: false,
      },
    },
  },
  required: ['path', 'count', 'entries'],
}

function toolCall(id: string, argumentsText: string): ToolCall {
  return { id, type: 'function', function: { name: 'probe', arguments: argumentsText } }
}

function scripted(steps: Message[], seen: Message[][]): NineRouterProvider {
  let index = 0
  return {
    model: 'test-model',
    stream(messages: Message[]) {
      seen.push(messages.map((message) => ({ ...message })))
      const message = steps[index++] ?? { role: 'assistant', content: 'selesai' }
      // eslint-disable-next-line require-yield
      return (async function* reply() {
        return { finishReason: message.tool_calls?.length ? 'tool_calls' : 'stop', message }
      })()
    },
  } as unknown as NineRouterProvider
}

test('validator memeriksa root, required, nested type, enum, batas, pola, dan field asing', () => {
  assert.deepEqual(validateToolArguments(parameters, []), ['$: harus berupa objek'])
  const issues = validateToolArguments(parameters, {
    path: 'app.js', count: 4.5, mode: 'hapus',
    entries: [{ extra: true }, { label: 'dua' }, { label: 'tiga' }],
  })
  assert.deepEqual(issues, [
    '$.path: format tidak sesuai pola \\.ts$',
    '$.count: harus berupa bilangan bulat',
    '$.mode: harus salah satu dari "read", "write"',
    '$.entries: maksimal 2 item',
    '$.entries[0].label: wajib diisi',
    '$.entries[0].extra: field tidak dikenal',
  ])
  assert.deepEqual(validateToolArguments(parameters, { path: 'app.ts', count: 1, entries: [{ label: 'satu' }] }), [])
})

test('Agent menolak JSON/schema invalid sebelum preview, approval, dan eksekusi lalu memberi koreksi trusted', async () => {
  let previews = 0
  let approvals = 0
  let runs = 0
  const probe: Tool = {
    name: 'probe', description: 'probe', risk: 'confirm',
    schema: { type: 'function', function: { name: 'probe', description: 'probe', parameters: {
      type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'],
    } } },
    preview: (args) => { previews += 1; return `probe ${(args as { path: string }).path}` },
    async run() { runs += 1; return { content: 'ok' } },
  }
  const seen: Message[][] = []
  const secretMalformed = 'JANGAN_TERSIMPAN'
  const agent = new Agent({
    provider: scripted([
      { role: 'assistant', content: null, tool_calls: [toolCall('json', `{"path":"${secretMalformed}","content":`)] },
      { role: 'assistant', content: null, tool_calls: [toolCall('schema', JSON.stringify({ path: 'a.txt' }))] },
      { role: 'assistant', content: null, tool_calls: [toolCall('valid', JSON.stringify({ path: 'a.txt', content: 'isi' }))] },
      { role: 'assistant', content: 'selesai' },
    ], seen),
    registry: createRegistry([probe]), workspace: mkdtempSync(join(tmpdir(), 'boo-tool-args-')),
    askPermission: async () => { approvals += 1; return true },
  })
  const events: AgentEvent[] = []
  for await (const event of agent.send('jalankan probe')) events.push(event)

  const invalid = events.filter((event) => event.type === 'tool-invalid')
  assert.deepEqual(invalid.map((event) => event.kind), ['json', 'schema'])
  assert.equal(previews, 1)
  assert.equal(approvals, 1)
  assert.equal(runs, 1)
  assert.ok(seen[1].some((message) => message.role === 'system' && message.content?.includes(TOOL_ARGUMENT_GUARD_MARK)))
  assert.ok(seen[2].some((message) => message.role === 'system' && message.content?.includes('$.content: wajib diisi')))
  const invalidResults = agent.history.filter((message) => message.role === 'tool' && message.content?.includes(TOOL_ARGUMENT_GUARD_MARK))
  assert.equal(invalidResults.length, 2)
  assert.doesNotMatch(invalidResults.map((message) => message.content).join('\n'), new RegExp(secretMalformed))
  assert.equal((await agent.taskStatus()).tools.invalid, 2)
  assert.equal(agent.history.at(-1)?.content, 'selesai')
})

test('preview yang melempar tidak menjatuhkan agent atau meminta approval', async () => {
  let approvals = 0
  let runs = 0
  const tool: Tool = {
    name: 'probe', description: 'probe', risk: 'confirm',
    schema: { type: 'function', function: { name: 'probe', description: 'probe', parameters: { type: 'object', properties: {} } } },
    preview: () => { throw new Error('preview rusak') },
    async run() { runs += 1; return { content: 'tidak boleh' } },
  }
  const agent = new Agent({
    provider: scripted([
      { role: 'assistant', content: null, tool_calls: [toolCall('preview', '{}')] },
      { role: 'assistant', content: 'menggunakan pendekatan lain' },
    ], []),
    registry: createRegistry([tool]), workspace: mkdtempSync(join(tmpdir(), 'boo-tool-preview-')),
    askPermission: async () => { approvals += 1; return true },
  })
  const events: AgentEvent[] = []
  for await (const event of agent.send('probe')) events.push(event)
  assert.equal(approvals, 0)
  assert.equal(runs, 0)
  assert.equal(events.find((event) => event.type === 'tool-invalid')?.kind, 'preview')
  assert.equal(agent.history.at(-1)?.content, 'menggunakan pendekatan lain')
})
