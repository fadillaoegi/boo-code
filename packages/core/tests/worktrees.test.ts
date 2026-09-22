import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Agent } from '../src/agent/loop.ts'
import { Checkpoints } from '../src/agent/checkpoints.ts'
import type { Message, ToolSchema } from '../src/domain/message.ts'
import type { NineRouterProvider } from '../src/provider/nineRouter.ts'
import { createDefaultRegistry } from '../src/tools/index.ts'
import { WRITABLE_SUBAGENT_SYSTEM_PROMPT } from '../src/tools/delegate.ts'
import { IsolatedWorktreeBatch, mergeWorktreeChanges, worktreeStorageRoot } from '../src/tools/worktrees.ts'

async function repository(prefix: string): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), prefix))
  execFileSync('git', ['init', '--quiet'], { cwd: workspace })
  await writeFile(join(workspace, 'a.txt'), 'awal\n')
  execFileSync('git', ['add', 'a.txt'], { cwd: workspace })
  execFileSync('git', ['-c', 'user.name=Boo Test', '-c', 'user.email=boo@example.invalid', 'commit', '--quiet', '-m', 'initial'], { cwd: workspace })
  return workspace
}

test('worktree menerima snapshot dirty, merge perubahan, dan dibersihkan', async () => {
  const workspace = await repository('boo-worktree-')
  const home = await mkdtemp(join(tmpdir(), 'boo-worktree-home-'))
  await writeFile(join(workspace, 'a.txt'), 'perubahan pengguna\n')
  const batch = await IsolatedWorktreeBatch.create({ workspace, home })
  const lease = await batch.prepare('writer')
  assert.equal(await readFile(join(lease.path, 'a.txt'), 'utf8'), 'perubahan pengguna\n')

  const checkpoints = new Checkpoints(lease.path)
  checkpoints.begin('ubah a')
  await checkpoints.beforeWrite(join(lease.path, 'a.txt'))
  await writeFile(join(lease.path, 'a.txt'), 'hasil sub-agent\n')
  await checkpoints.afterWrite(join(lease.path, 'a.txt'))
  const merged = await mergeWorktreeChanges(workspace, await checkpoints.currentChanges())
  assert.deepEqual(merged, { applied: ['a.txt'], conflicts: [] })
  assert.equal(await readFile(join(workspace, 'a.txt'), 'utf8'), 'hasil sub-agent\n')

  await batch.close()
  assert.deepEqual(await readdir(worktreeStorageRoot(workspace, home)), [])
  assert.equal(execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: workspace, encoding: 'utf8' }).match(/^worktree /gm)?.length, 1)
})

test('merge menolak seluruh task bila workspace utama berubah setelah snapshot', async () => {
  const workspace = await repository('boo-worktree-conflict-')
  const home = await mkdtemp(join(tmpdir(), 'boo-worktree-home-'))
  const batch = await IsolatedWorktreeBatch.create({ workspace, home })
  try {
    const lease = await batch.prepare('conflict')
    const checkpoints = new Checkpoints(lease.path)
    checkpoints.begin('ubah a')
    await checkpoints.beforeWrite(join(lease.path, 'a.txt'))
    await writeFile(join(lease.path, 'a.txt'), 'hasil child\n')
    await checkpoints.afterWrite(join(lease.path, 'a.txt'))
    await writeFile(join(workspace, 'a.txt'), 'edit pengguna sesudah snapshot\n')
    const merged = await mergeWorktreeChanges(workspace, await checkpoints.currentChanges())
    assert.deepEqual(merged, { applied: [], conflicts: ['a.txt'] })
    assert.equal(await readFile(join(workspace, 'a.txt'), 'utf8'), 'edit pengguna sesudah snapshot\n')
  } finally {
    await batch.close()
  }
})

test('agent menjalankan dua implementasi paralel dan merge dengan satu approval batch', async () => {
  const workspace = await repository('boo-worktree-agent-')
  const home = await mkdtemp(join(tmpdir(), 'boo-worktree-home-'))
  let parentTurns = 0
  const childTurns = new Map<string, number>()
  const childSchemas: string[][] = []
  const provider = {
    model: 'model-terpilih',
    reasoningEffort: 'high',
    stream(messages: Message[], tools: ToolSchema[]) {
      const child = messages[0]?.content?.startsWith(WRITABLE_SUBAGENT_SYSTEM_PROMPT) === true
      if (child) {
        childSchemas.push(tools.map((tool) => tool.function.name))
        const task = messages.find((message) => message.role === 'user')?.content ?? ''
        const id = task.includes('alpha') ? 'alpha' : 'beta'
        const turn = (childTurns.get(id) ?? 0) + 1
        childTurns.set(id, turn)
        // eslint-disable-next-line require-yield
        return (async function* childReply() {
          if (turn === 1) return {
            finishReason: 'tool_calls',
            message: { role: 'assistant' as const, content: null, tool_calls: [{
              id: `write-${id}`, type: 'function' as const,
              function: { name: 'write_file', arguments: JSON.stringify({ path: `${id}.txt`, content: `${id}\n` }) },
            }] },
          }
          return { finishReason: 'stop', message: { role: 'assistant' as const, content: `${id} selesai` } }
        })()
      }
      parentTurns += 1
      // eslint-disable-next-line require-yield
      return (async function* parentReply() {
        if (parentTurns === 1) return {
          finishReason: 'tool_calls',
          message: { role: 'assistant' as const, content: null, tool_calls: [{
            id: 'delegate-write', type: 'function' as const,
            function: { name: 'delegate_write', arguments: JSON.stringify({ tasks: [
              { id: 'alpha', task: 'implementasikan alpha' },
              { id: 'beta', task: 'implementasikan beta' },
            ] }) },
          }] },
        }
        return { finishReason: 'stop', message: { role: 'assistant' as const, content: 'semua selesai' } }
      })()
    },
  } as unknown as NineRouterProvider
  const approvals: string[] = []
  const agent = new Agent({
    provider,
    registry: createDefaultRegistry(),
    workspace,
    home,
    verifyCompletion: false,
    askPermission: async ({ name }) => {
      approvals.push(name)
      return true
    },
  })
  const output: string[] = []
  for await (const event of agent.send('kerjakan dua area paralel')) {
    if (event.type === 'tool-output') output.push(event.chunk)
  }
  assert.deepEqual(approvals, ['delegate_write'])
  assert.equal(await readFile(join(workspace, 'alpha.txt'), 'utf8'), 'alpha\n')
  assert.equal(await readFile(join(workspace, 'beta.txt'), 'utf8'), 'beta\n')
  assert.match(output.join(''), /\[alpha\] digabungkan: alpha\.txt/)
  assert.ok(childSchemas.every((names) => names.includes('write_file') && !names.includes('bash') && !names.includes('delegate_write')))
})
