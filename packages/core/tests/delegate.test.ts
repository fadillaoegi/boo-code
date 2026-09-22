import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Agent, type AgentEvent } from '../src/agent/loop.ts'
import type { Message, ToolSchema } from '../src/domain/message.ts'
import type { DelegatedResult } from '../src/domain/tool.ts'
import type { NineRouterProvider } from '../src/provider/nineRouter.ts'
import { createSubagentRegistry, createWritableSubagentRegistry, delegateTool, delegateWriteTool, SUBAGENT_SYSTEM_PROMPT } from '../src/tools/delegate.ts'
import { createDefaultRegistry } from '../src/tools/index.ts'

test('registry sub-agent hanya berisi tool eksplorasi dan tidak dapat mendelegasikan lagi', () => {
  const registry = createSubagentRegistry()
  const names = registry.list().map((tool) => tool.name)
  assert.ok(names.includes('read_file'))
  assert.ok(names.includes('repo_map'))
  assert.ok(names.includes('git_diff'))
  for (const forbidden of ['delegate', 'write_file', 'edit_file', 'apply_patch', 'bash', 'diagnostics', 'lsp', 'mcp_call', 'open_app', 'whatsapp_send_message']) {
    assert.ok(!names.includes(forbidden), `${forbidden} tidak boleh tersedia bagi sub-agent`)
  }
  assert.ok(registry.list().every((tool) => tool.risk === 'safe'))
})

test('registry sub-agent penulis hanya menambah file tools tanpa shell atau efek eksternal', () => {
  const names = createWritableSubagentRegistry().list().map((tool) => tool.name)
  for (const required of ['read_file', 'write_file', 'edit_file', 'apply_patch', 'todo_write']) assert.ok(names.includes(required))
  for (const forbidden of ['bash', 'diagnostics', 'lsp', 'delegate', 'delegate_write', 'mcp_call', 'open_app', 'whatsapp_send_message']) {
    assert.ok(!names.includes(forbidden), `${forbidden} tidak boleh tersedia bagi sub-agent penulis`)
  }
})

test('delegate_write selalu meminta approval baru dan meneruskan hasil merge', async () => {
  assert.equal(delegateWriteTool.risk, 'confirm')
  assert.equal(delegateWriteTool.allowAlways, false)
  const result = await delegateWriteTool.run({ tasks: [{ id: 'api', task: 'ubah API' }] }, {
    workspace: '/unused',
    delegateWrite: async () => [{ id: 'api', status: 'completed', content: 'selesai', turns: 2, toolCalls: 1, changedFiles: ['api.ts'] }],
  })
  assert.equal(result.isError, undefined)
  assert.match(result.content, /merged: api\.ts/)
})

test('delegate membatasi input dan memulai tiga task secara paralel', async () => {
  const duplicate = await delegateTool.run({ tasks: [{ id: 'same', task: 'a' }, { id: 'same', task: 'b' }] }, { workspace: '/unused' })
  assert.equal(duplicate.isError, true)
  assert.match(duplicate.content, /duplikat/)

  let active = 0
  let peak = 0
  const result = await delegateTool.run({ tasks: [
    { id: 'one', task: 'satu' }, { id: 'two', task: 'dua' }, { id: 'three', task: 'tiga' },
  ] }, {
    workspace: '/unused',
    delegate: async (task): Promise<DelegatedResult> => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise<void>((resolve) => setImmediate(resolve))
      active -= 1
      return { id: task.id, status: 'completed', content: `hasil ${task.task}`, turns: 1, toolCalls: 0 }
    },
  })
  assert.equal(peak, 3)
  assert.equal(result.isError, undefined)
  assert.match(result.content, /## one \[completed\]/)
  assert.match(result.content, /hasil tiga/)
})

test('agent utama menerima laporan sub-agent dengan riwayat dan tool terisolasi', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'boo-delegate-'))
  writeFileSync(join(workspace, 'data.txt'), 'bukti penting\n')
  let parentTurns = 0
  let childTurns = 0
  const childSchemas: string[][] = []
  const parentToolResults: string[] = []
  const provider = {
    model: 'model-terpilih',
    reasoningEffort: 'high',
    stream(messages: Message[], tools: ToolSchema[]) {
      const child = messages[0]?.content?.startsWith(SUBAGENT_SYSTEM_PROMPT) === true
      if (child) {
        childSchemas.push(tools.map((tool) => tool.function.name))
        childTurns += 1
        // eslint-disable-next-line require-yield
        return (async function* childReply() {
          if (childTurns === 1) return {
            finishReason: 'tool_calls',
            message: { role: 'assistant' as const, content: null, tool_calls: [{
              id: 'child-read', type: 'function' as const,
              function: { name: 'read_file', arguments: JSON.stringify({ path: 'data.txt' }) },
            }] },
          }
          return { finishReason: 'stop', message: { role: 'assistant' as const, content: 'Temuan: data.txt:1 berisi bukti penting.' } }
        })()
      }

      parentTurns += 1
      parentToolResults.push(...messages.filter((message) => message.role === 'tool').map((message) => message.content ?? ''))
      // eslint-disable-next-line require-yield
      return (async function* parentReply() {
        if (parentTurns === 1) return {
          finishReason: 'tool_calls',
          message: { role: 'assistant' as const, content: null, tool_calls: [{
            id: 'parent-delegate', type: 'function' as const,
            function: { name: 'delegate', arguments: JSON.stringify({ tasks: [{ id: 'inspect', task: 'Periksa data.txt dan laporkan buktinya.' }] }) },
          }] },
        }
        return { finishReason: 'stop', message: { role: 'assistant' as const, content: 'Agent utama memakai hasil investigasi.' } }
      })()
    },
  } as unknown as NineRouterProvider

  const agent = new Agent({
    provider,
    registry: createDefaultRegistry(),
    workspace,
    askPermission: async () => { throw new Error('Sub-agent baca-saja tidak boleh meminta approval') },
    verifyCompletion: false,
  })
  const events: AgentEvent[] = []
  for await (const event of agent.send('Selidiki data secara paralel.')) events.push(event)

  assert.equal(parentTurns, 2)
  assert.equal(childTurns, 2)
  assert.match(parentToolResults.at(-1) ?? '', /data\.txt:1 berisi bukti penting/)
  assert.equal(agent.history.at(-1)?.content, 'Agent utama memakai hasil investigasi.')
  assert.ok(events.some((event) => event.type === 'tool-output' && event.chunk.includes('[inspect] baca data.txt')))
  assert.ok(childSchemas.every((names) => names.includes('read_file') && !names.includes('write_file') && !names.includes('delegate')))
})
