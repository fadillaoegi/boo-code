import assert from 'node:assert/strict'
import test from 'node:test'
import type { Message } from '../src/domain/message.ts'
import { latestTodos, parseTodos, todoWriteTool } from '../src/tools/todo.ts'

const run = (todos: unknown) => todoWriteTool.run({ todos }, { workspace: '/tmp' })

test('daftar yang sah diterima dan kemajuannya dilaporkan', async () => {
  const result = await run([
    { content: 'Baca parser', status: 'completed' },
    { content: 'Perbaiki bug', status: 'in_progress' },
    { content: 'Tambah test', status: 'pending' },
  ])
  assert.equal(result.isError, undefined)
  assert.match(result.content, /1\/3 selesai\. Sedang dikerjakan: Perbaiki bug\./)
  assert.match((await run([{ content: 'a', status: 'completed' }])).content, /semua 1 tugas selesai/)
})

test('lebih dari satu tugas in_progress, status asing, atau isi kosong ditolak', async () => {
  const twoActive = await run([{ content: 'a', status: 'in_progress' }, { content: 'b', status: 'in_progress' }])
  assert.equal(twoActive.isError, true)
  assert.match(twoActive.content, /Hanya satu/)
  assert.equal(typeof parseTodos([{ content: 'a', status: 'done' }]), 'string')
  assert.equal(typeof parseTodos([{ content: '  ', status: 'pending' }]), 'string')
  assert.equal(typeof parseTodos('bukan array'), 'string')
})

test('daftar terbaru dibaca dari riwayat, melewati pemanggilan yang tidak sah', () => {
  const call = (id: string, todos: unknown): Message => ({
    role: 'assistant',
    content: null,
    tool_calls: [{ id, type: 'function', function: { name: 'todo_write', arguments: JSON.stringify({ todos }) } }],
  })
  const history: Message[] = [
    { role: 'user', content: 'kerjakan' },
    call('1', [{ content: 'lama', status: 'pending' }]),
    call('2', [{ content: 'baru', status: 'in_progress' }]),
    call('3', [{ content: 'x', status: 'in_progress' }, { content: 'y', status: 'in_progress' }]),
  ]
  assert.deepEqual(latestTodos(history), [{ content: 'baru', status: 'in_progress' }])
  assert.deepEqual(latestTodos([]), [])
})
