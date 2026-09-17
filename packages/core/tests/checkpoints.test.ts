import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Agent } from '../src/agent/loop.ts'
import { splitUndoNote } from '../src/agent/checkpoints.ts'
import type { Message, ToolCall } from '../src/domain/message.ts'
import type { NineRouterProvider } from '../src/provider/nineRouter.ts'
import { editFileTool } from '../src/tools/editFile.ts'
import { createDefaultRegistry } from '../src/tools/index.ts'

function workspace(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'boo-undo-')))
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', 'app.ts'), 'const a = 1\n')
  return dir
}

function call(id: string, name: string, args: object): ToolCall {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}

/** Setiap permintaan: model memanggil tool yang diberikan, lalu menjawab "selesai". */
function agentFor(dir: string, plans: ToolCall[][], seen: Message[][] = []) {
  let request = -1
  const provider = {
    model: 'palsu',
    stream(messages: Message[]) {
      seen.push(messages.map((message) => ({ ...message })))
      const last = messages.at(-1)!
      if (last.role === 'user') request += 1
      const calls = last.role === 'user' ? plans[request] ?? [] : []
      const message: Message = calls.length ? { role: 'assistant', content: null, tool_calls: calls } : { role: 'assistant', content: 'selesai' }
      // eslint-disable-next-line require-yield
      return (async function* reply() {
        return { finishReason: calls.length ? 'tool_calls' : 'stop', message }
      })()
    },
  } as unknown as NineRouterProvider
  return new Agent({ provider, registry: createDefaultRegistry(), workspace: dir, askPermission: async () => true })
}

async function run(agent: Agent, input: string) {
  for await (const event of agent.send(input)) void event
}

test('undo mengembalikan isi berkas, menghapus berkas baru beserta folder yang ikut dibuat', async () => {
  const dir = workspace()
  const agent = agentFor(dir, [[
    call('1', 'edit_file', { path: 'src/app.ts', old_text: 'const a = 1', new_text: 'const a = 2' }),
    call('2', 'write_file', { path: 'src/fitur/baru/modul.ts', content: 'export {}\n' }),
    call('3', 'edit_file', { path: 'src/app.ts', old_text: 'const a = 2', new_text: 'const a = 3' }),
  ]])
  await run(agent, 'ubah app dan buat modul')
  assert.equal(readFileSync(join(dir, 'src/app.ts'), 'utf8'), 'const a = 3\n')

  const plan = await agent.checkpoints.plan()
  assert.deepEqual(plan?.entries.map((entry) => [entry.label, entry.action, entry.modifiedSince, entry.added, entry.removed]), [
    ['src/app.ts', 'restore', false, 1, 1],
    ['src/fitur/baru/modul.ts', 'delete', false, 0, 1],
  ])

  await agent.undo()
  assert.equal(readFileSync(join(dir, 'src/app.ts'), 'utf8'), 'const a = 1\n', 'kembali ke isi sebelum permintaan, bukan sebelum edit terakhir')
  assert.ok(!existsSync(join(dir, 'src/fitur')), 'folder yang dibuat Boo ikut dihapus')
  assert.ok(existsSync(join(dir, 'src')), 'folder yang sudah ada sebelumnya tetap')
  assert.equal(await agent.checkpoints.plan(), null)
})

test('undo berulang mundur satu permintaan demi satu, melewati permintaan tanpa perubahan', async () => {
  const dir = workspace()
  const agent = agentFor(dir, [
    [call('1', 'write_file', { path: 'satu.txt', content: 'v1' })],
    [call('2', 'write_file', { path: 'satu.txt', content: 'v2' })],
    [call('3', 'read_file', { path: 'satu.txt' })],
  ])
  await run(agent, 'pertama')
  await run(agent, 'kedua')
  await run(agent, 'hanya membaca')

  assert.equal((await agent.undo())?.prompt, 'kedua')
  assert.equal(readFileSync(join(dir, 'satu.txt'), 'utf8'), 'v1')
  assert.equal((await agent.undo())?.prompt, 'pertama')
  assert.ok(!existsSync(join(dir, 'satu.txt')))
})

test('berkas yang diubah pengguna setelah Boo ditandai; perintah bash diberi peringatan', async () => {
  const dir = workspace()
  const agent = agentFor(dir, [[
    call('1', 'edit_file', { path: 'src/app.ts', old_text: '1', new_text: '2' }),
    call('2', 'bash', { command: 'true' }),
  ]])
  await run(agent, 'ubah')
  writeFileSync(join(dir, 'src/app.ts'), 'const a = 2\n// tambahan pengguna\n')
  const plan = await agent.checkpoints.plan()
  assert.equal(plan?.entries[0].modifiedSince, true)
  assert.equal(plan?.ranCommands, true)
})

test('model diberi tahu pada permintaan berikutnya, dan pertanyaan aslinya dapat dipisahkan', async () => {
  const dir = workspace()
  const seen: Message[][] = []
  const agent = agentFor(dir, [[call('1', 'write_file', { path: 'baru.txt', content: 'x' })], []], seen)
  await run(agent, 'buat berkas')
  await agent.undo()
  await run(agent, 'sekarang apa?')

  const sent = seen.at(-1)!.at(-1)!.content as string
  assert.match(sent, /\/undo[\s\S]*dihapus karena baru dibuat: baru\.txt[\s\S]*sekarang apa\?$/)
  assert.deepEqual(splitUndoNote(sent), { note: true, text: 'sekarang apa?' })
  assert.deepEqual(splitUndoNote('biasa'), { note: false, text: 'biasa' })
})

test('edit_file tidak menafsirkan $ di teks pengganti', async () => {
  const dir = workspace()
  writeFileSync(join(dir, 'skrip.sh'), 'echo PID\n')
  await editFileTool.run({ path: 'skrip.sh', old_text: 'PID', new_text: "$$ $& $1 $'" }, { workspace: dir })
  assert.equal(readFileSync(join(dir, 'skrip.sh'), 'utf8'), "echo $$ $& $1 $'\n")
})
