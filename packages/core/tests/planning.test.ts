import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Agent } from '../src/agent/loop.ts'
import { implementPlanRequest, latestPlan, PLAN_SYSTEM_PROMPT, planPromptTitle, planRequest } from '../src/agent/planning.ts'
import type { Message, ToolSchema } from '../src/domain/message.ts'
import { buildTranscript } from '../src/presentation/transcript.ts'
import type { NineRouterProvider } from '../src/provider/nineRouter.ts'
import { createDefaultRegistry } from '../src/tools/index.ts'

test('mode plan bersifat read-only dan menyimpan rencana final di history', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'boo-plan-'))
  const target = join(workspace, 'app.ts')
  writeFileSync(target, 'const value = 1\n')
  let turn = 0
  const schemas: string[][] = []
  const seen: Message[][] = []
  const provider = {
    model: 'plan-model',
    stream(messages: Message[], tools: ToolSchema[]) {
      seen.push(messages)
      schemas.push(tools.map((tool) => tool.function.name))
      turn += 1
      // eslint-disable-next-line require-yield
      return (async function* reply() {
        if (turn === 1) return {
          finishReason: 'tool_calls',
          message: { role: 'assistant' as const, content: null, tool_calls: [{
            id: 'forbidden-write', type: 'function' as const,
            function: { name: 'write_file', arguments: JSON.stringify({ path: 'app.ts', content: 'rusak\n' }) },
          }] },
        }
        return { finishReason: 'stop', message: { role: 'assistant' as const, content: '1. Ubah `app.ts`.\n2. Jalankan test.' } }
      })()
    },
  } as unknown as NineRouterProvider
  const agent = new Agent({ provider, registry: createDefaultRegistry(), workspace, askPermission: async () => true, verifyCompletion: false })
  for await (const event of agent.send(planRequest('perbarui nilai'), { mode: 'plan' })) void event

  assert.equal(readFileSync(target, 'utf8'), 'const value = 1\n')
  assert.ok(schemas.every((names) => names.includes('read_file') && !names.includes('write_file') && !names.includes('bash')))
  assert.ok(seen[0].some((message) => message.role === 'system' && message.content?.includes(PLAN_SYSTEM_PROMPT)))
  assert.match(seen[1].find((message) => message.role === 'tool')?.content ?? '', /tidak dikenal/)
  assert.deepEqual(latestPlan(agent.history), { task: 'perbarui nilai', plan: '1. Ubah `app.ts`.\n2. Jalankan test.' })
})

test('latestPlan mengambil jawaban final setelah tool dan menolak plan terputus', () => {
  const complete: Message[] = [
    { role: 'user', content: planRequest('fitur antrean') },
    { role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'a', content: 'isi' },
    { role: 'assistant', content: 'Rencana final' },
  ]
  assert.deepEqual(latestPlan(complete), { task: 'fitur antrean', plan: 'Rencana final' })
  assert.equal(latestPlan(complete.slice(0, 3)), null)
})

test('prompt planning tampil sebagai command dan implementasi membawa rencana', () => {
  const request = planRequest('tambah cache')
  assert.equal(planPromptTitle(request), 'tambah cache')
  assert.throws(() => planRequest('   '), /Tulis tugas/)
  const implementation = implementPlanRequest({ task: 'tambah cache', plan: 'Ubah cache.ts lalu test.' })
  assert.match(implementation, /Original task:\ntambah cache/)
  assert.match(implementation, /Plan:\nUbah cache\.ts lalu test\./)

  const transcript = buildTranscript([
    { role: 'user', content: request },
    { role: 'assistant', content: 'Rencana.' },
    { role: 'user', content: implementation },
    { role: 'assistant', content: 'Selesai.' },
  ]).flat()
  assert.equal(transcript.find((item) => item.kind === 'user')?.text, '/plan tambah cache')
  assert.equal(transcript.filter((item) => item.kind === 'user')[1]?.text, '/implement')
})
