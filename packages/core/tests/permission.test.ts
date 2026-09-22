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

test('open_app meminta izin seperti tool yang menjalankan aksi lokal', async () => {
  const request = (await import('../src/presentation/approval.ts')).describeRequest('open_app', { id: 'editor' }, false)
  assert.equal(request.title, 'Buka aplikasi')
  assert.equal(request.question, 'Buka aplikasi editor?')
  assert.match(request.allowAlways, /editor/)
})

test('MCP discovery dan call menjelaskan tindakan yang memerlukan izin', async () => {
  const { describeRequest } = await import('../src/presentation/approval.ts')
  const discovery = describeRequest('mcp_list_tools', { server: 'database' }, false)
  assert.equal(discovery.title, 'Jalankan MCP server')
  assert.match(discovery.question, /database/)
  const call = describeRequest('mcp_call', { server: 'database', tool: 'query', arguments: { sql: 'select 1' } }, false)
  assert.equal(call.title, 'Panggil MCP tool')
  assert.match(call.question, /select 1/)
  assert.match(call.allowAlways, /setiap MCP call/)
})

test('perubahan memori menampilkan isi dan selalu meminta izin baru', async () => {
  const { describeRequest } = await import('../src/presentation/approval.ts')
  const add = describeRequest('memory_add', { text: 'Gunakan pnpm test', category: 'command' }, false)
  assert.equal(add.title, 'Simpan memori proyek')
  assert.match(add.question, /Gunakan pnpm test/)
  assert.match(add.allowAlways, /setiap catatan/)
  const remove = describeRequest('memory_remove', { id: 'deadbeef' }, false)
  assert.equal(remove.title, 'Hapus memori proyek')
  assert.match(remove.question, /deadbeef/)
})

test('delegasi penulisan menampilkan semua task dan tidak dapat diizinkan permanen', async () => {
  const { describeRequest } = await import('../src/presentation/approval.ts')
  const request = describeRequest('delegate_write', { tasks: [{ id: 'api', task: 'ubah API' }, { id: 'ui', task: 'ubah UI' }] }, false)
  assert.equal(request.title, 'Jalankan sub-agent penulis')
  assert.match(request.question, /api: ubah API/)
  assert.match(request.question, /ui: ubah UI/)
  assert.match(request.allowAlways, /setiap delegasi/)
})

test('input proses menampilkan isi persis dan selalu meminta izin baru', async () => {
  const { describeRequest } = await import('../src/presentation/approval.ts')
  const request = describeRequest('bash_input', { id: 'bg3', input: 'yes', close_stdin: true }, false)
  assert.equal(request.title, 'Kirim input ke proses')
  assert.match(request.question, /"yes\\n"/)
  assert.match(request.question, /stdin akan ditutup/)
  assert.equal(createDefaultRegistry().get('bash_input')?.allowAlways, false)
})

test('commit Git selalu meminta approval baru', () => {
  assert.equal(createDefaultRegistry().get('git_commit')?.allowAlways, false)
  assert.equal(createDefaultRegistry().get('git_commit')?.writesWorkspace, true)
})
