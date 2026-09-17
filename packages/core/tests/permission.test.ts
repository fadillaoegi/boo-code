import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Agent } from '../src/agent/loop.ts'
import type { Message } from '../src/domain/message.ts'
import type { NineRouterProvider } from '../src/provider/nineRouter.ts'
import { createDefaultRegistry } from '../src/tools/index.ts'

/** Provider palsu: putaran pertama meminta write_file, putaran kedua menjawab. */
function fakeProvider(seen: Message[][]) {
  let turn = 0
  return {
    model: 'palsu',
    // Provider sungguhan mengalirkan potongan; yang ini langsung selesai.
    // eslint-disable-next-line require-yield
    async *stream(messages: Message[]) {
      seen.push(messages.map((message) => ({ ...message })))
      turn += 1
      if (turn === 1) {
        return {
          finishReason: 'tool_calls',
          message: {
            role: 'assistant' as const,
            content: null,
            tool_calls: [{
              id: 'call_1',
              type: 'function' as const,
              function: { name: 'write_file', arguments: JSON.stringify({ path: 'a.txt', content: 'isi' }) },
            }],
          },
        }
      }
      return { finishReason: 'stop', message: { role: 'assistant' as const, content: 'baik' } }
    },
  } as unknown as NineRouterProvider
}

async function run(answer: boolean | { allowed: boolean; feedback?: string }) {
  const workspace = await mkdtemp(join(tmpdir(), 'boo-izin-'))
  const seen: Message[][] = []
  const agent = new Agent({
    provider: fakeProvider(seen),
    registry: createDefaultRegistry(),
    workspace,
    askPermission: async () => answer,
  })
  const events = []
  for await (const event of agent.send('tulis a.txt')) events.push(event)
  const toolResult = seen[1]?.find((message) => message.role === 'tool')
  return { workspace, events, toolResult }
}

test('arahan penolakan diteruskan ke model sebagai hasil tool', async () => {
  const { workspace, events, toolResult } = await run({ allowed: false, feedback: 'pakai nama catatan.txt saja' })
  assert.ok(!existsSync(join(workspace, 'a.txt')), 'berkas tidak boleh ditulis')
  assert.match(String(toolResult?.content), /pakai nama catatan\.txt saja/)
  const denied = events.find((event) => event.type === 'tool-denied')
  assert.equal(denied && 'feedback' in denied ? denied.feedback : undefined, 'pakai nama catatan.txt saja')
})

test('penolakan tanpa arahan tetap memberi tahu model', async () => {
  const { toolResult } = await run({ allowed: false })
  assert.match(String(toolResult?.content), /Ditolak oleh pengguna/)
  assert.doesNotMatch(String(toolResult?.content), /arahan/)
})

test('jawaban boolean lama tetap didukung', async () => {
  const denied = await run(false)
  assert.match(String(denied.toolResult?.content), /Ditolak oleh pengguna/)
  const allowed = await run(true)
  assert.ok(existsSync(join(allowed.workspace, 'a.txt')), 'izin true harus menulis berkas')
})
