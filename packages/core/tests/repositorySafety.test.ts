import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Agent } from '../src/agent/loop.ts'
import type { Message } from '../src/domain/message.ts'
import type { NineRouterProvider } from '../src/provider/nineRouter.ts'
import { FILE_FRESHNESS_NOTICE_PREFIX, FileSnapshots } from '../src/tools/fileSnapshots.ts'
import { gitChangedFilesTool, gitDiffTool, gitStatusTool } from '../src/tools/git.ts'
import { createDefaultRegistry } from '../src/tools/index.ts'
import { resolveInWorkspace, WorkspaceError } from '../src/tools/workspace.ts'

test('snapshot membedakan perubahan eksternal dari pembacaan ulang eksplisit', () => {
  const snapshots = new FileSnapshots()
  snapshots.capture('/workspace/a.ts', Buffer.from('awal'))
  assert.equal(snapshots.matches('/workspace/a.ts', Buffer.from('berubah')), false)
  snapshots.capture('/workspace/a.ts', Buffer.from('berubah'))
  assert.equal(snapshots.matches('/workspace/a.ts', Buffer.from('berubah')), false, 'capture tidak boleh menghapus konflik')
  snapshots.observe('/workspace/a.ts', Buffer.from('berubah'))
  assert.equal(snapshots.matches('/workspace/a.ts', Buffer.from('berubah')), true)
})

test('snapshot melaporkan file modified, deleted, dan path yang menjadi tidak aman', { skip: process.platform === 'win32' }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'boo-freshness-'))
  const outside = await mkdtemp(join(tmpdir(), 'boo-freshness-outside-'))
  const target = join(workspace, 'app.ts')
  await writeFile(target, 'awal\n')
  const snapshots = new FileSnapshots()
  snapshots.observe(target, Buffer.from('awal\n'))

  await writeFile(target, 'berubah dan lebih panjang\n')
  assert.deepEqual(await snapshots.changed(workspace), [{ path: 'app.ts', kind: 'modified' }])
  snapshots.observe(target, Buffer.from('berubah dan lebih panjang\n'))
  assert.deepEqual(await snapshots.changed(workspace), [])

  await unlink(target)
  assert.deepEqual(await snapshots.changed(workspace), [{ path: 'app.ts', kind: 'deleted' }])
  await writeFile(join(outside, 'secret.ts'), 'rahasia\n')
  await symlink(join(outside, 'secret.ts'), target)
  assert.deepEqual(await snapshots.changed(workspace), [{ path: 'app.ts', kind: 'unsafe' }])
})

test('label freshness menetralkan karakter kontrol pada nama file', { skip: process.platform === 'win32' }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'boo-freshness-label-'))
  const target = join(workspace, `aneh\n${String.fromCharCode(27)}[31m.ts`)
  await writeFile(target, 'awal\n')
  const snapshots = new FileSnapshots()
  snapshots.observe(target, Buffer.from('awal\n'))
  await writeFile(target, 'berubah lebih panjang\n')

  const [change] = await snapshots.changed(workspace)
  assert.equal(change.path, 'aneh\\u000a\\u001b[31m.ts')
  assert.equal(change.path.includes('\n'), false)
  assert.equal(change.path.includes('\r'), false)
  assert.equal(change.path.includes(String.fromCharCode(27)), false)
})

test('agent memberi notice sementara lalu berhenti setelah file dibaca ulang', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'boo-freshness-agent-'))
  const target = join(workspace, 'app.ts')
  await writeFile(target, 'versi satu\n')
  const seen: Message[][] = []
  let call = 0
  const readCall = (id: string) => ({
    finishReason: 'tool_calls',
    message: {
      role: 'assistant' as const,
      content: null,
      tool_calls: [{ id, type: 'function' as const, function: { name: 'read_file', arguments: '{"path":"app.ts"}' } }],
    },
  })
  const provider = {
    model: 'palsu',
    stream(messages: Message[]) {
      seen.push(messages.map((message) => ({ ...message })))
      call += 1
      // eslint-disable-next-line require-yield
      return (async function* () {
        if (call === 1) return readCall('read-first')
        if (call === 3) return readCall('read-fresh')
        return { finishReason: 'stop', message: { role: 'assistant' as const, content: 'selesai' } }
      })()
    },
  } as unknown as NineRouterProvider
  const agent = new Agent({
    provider,
    registry: createDefaultRegistry(),
    workspace,
    verifyCompletion: false,
    askPermission: async () => true,
  })

  for await (const event of agent.send('baca app')) void event
  await writeFile(target, 'versi dua dari editor\n')
  const events = []
  for await (const event of agent.send('lanjutkan')) events.push(event)

  const changed = events.filter((event) => event.type === 'workspace-changed')
  assert.equal(changed.length, 1)
  assert.deepEqual(changed[0]?.type === 'workspace-changed' ? changed[0].files : [], [{ path: 'app.ts', kind: 'modified' }])
  assert.ok(seen[2].some((message) => message.role === 'system' && String(message.content).includes(FILE_FRESHNESS_NOTICE_PREFIX)))
  assert.ok(!seen[3].some((message) => String(message.content).includes(FILE_FRESHNESS_NOTICE_PREFIX)), 'notice hilang setelah read_file mengamati isi baru')
  assert.equal(agent.history.some((message) => String(message.content).includes(FILE_FRESHNESS_NOTICE_PREFIX)), false, 'notice tidak mencemari history')
})

test('resolver workspace menolak symlink yang keluar dari workspace', { skip: process.platform === 'win32' }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'boo-symlink-workspace-'))
  const outside = await mkdtemp(join(tmpdir(), 'boo-symlink-outside-'))
  await writeFile(join(outside, 'secret.txt'), 'jangan disentuh\n')
  await symlink(join(outside, 'secret.txt'), join(workspace, 'link.txt'))
  assert.throws(() => resolveInWorkspace(workspace, 'link.txt'), WorkspaceError)
})

test('perubahan pengguna saat approval terbuka tidak ditimpa write_file', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'boo-stale-write-'))
  const target = join(workspace, 'app.ts')
  await writeFile(target, 'versi awal\n')
  let turn = 0
  const provider = {
    model: 'palsu',
    // eslint-disable-next-line require-yield
    async *stream() {
      turn += 1
      if (turn === 1) {
        return {
          finishReason: 'tool_calls',
          message: {
            role: 'assistant' as const,
            content: null,
            tool_calls: [{
              id: 'write', type: 'function' as const,
              function: { name: 'write_file', arguments: JSON.stringify({ path: 'app.ts', content: 'versi Boo\n' }) },
            }],
          },
        }
      }
      return { finishReason: 'stop', message: { role: 'assistant' as const, content: 'selesai' } }
    },
  } as unknown as NineRouterProvider
  const agent = new Agent({
    provider,
    registry: createDefaultRegistry(),
    workspace,
    verifyCompletion: false,
    askPermission: async () => {
      await writeFile(target, 'perubahan pengguna\n')
      return true
    },
  })
  const events = []
  for await (const event of agent.send('ubah app.ts')) events.push(event)
  assert.equal(await readFile(target, 'utf8'), 'perubahan pengguna\n')
  const result = events.find((event) => event.type === 'tool-end')
  assert.ok(result?.type === 'tool-end')
  assert.equal(result.isError, true)
  assert.match(result.content, /berubah sejak terakhir dibaca/)
})

test('git_status dan git_diff membaca perubahan repository tanpa shell bebas', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'boo-git-tools-'))
  execFileSync('git', ['init', '--quiet'], { cwd: workspace })
  await writeFile(join(workspace, 'app.ts'), 'const value = 1\n')
  execFileSync('git', ['add', 'app.ts'], { cwd: workspace })
  execFileSync('git', ['-c', 'user.name=Boo Test', '-c', 'user.email=boo@example.invalid', 'commit', '--quiet', '-m', 'initial'], { cwd: workspace })
  await writeFile(join(workspace, 'app.ts'), 'const value = 2\n')

  const status = await gitStatusTool.run({}, { workspace })
  assert.equal(status.isError, undefined)
  assert.match(status.content, / M app\.ts/)

  const diff = await gitDiffTool.run({ path: 'app.ts' }, { workspace })
  assert.equal(diff.isError, undefined)
  assert.match(diff.content, /-const value = 1/)
  assert.match(diff.content, /\+const value = 2/)
})

test('git_diff menolak membaca isi file sensitif', async () => {
  const result = await gitDiffTool.run({ path: '.env' }, { workspace: process.cwd() })
  assert.equal(result.isError, true)
  assert.doesNotMatch(result.content, /SECRET=/)
})

test('review branch dapat melihat daftar file dan diff terhadap base tanpa membocorkan file sensitif', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'boo-git-review-'))
  execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: workspace })
  await writeFile(join(workspace, 'app.ts'), 'export const value = 1\n')
  await writeFile(join(workspace, '.env'), 'SECRET=awal\n')
  execFileSync('git', ['add', 'app.ts', '.env'], { cwd: workspace })
  execFileSync('git', ['-c', 'user.name=Boo Test', '-c', 'user.email=boo@example.invalid', 'commit', '--quiet', '-m', 'initial'], { cwd: workspace })
  execFileSync('git', ['checkout', '--quiet', '-b', 'feature'], { cwd: workspace })
  await writeFile(join(workspace, 'app.ts'), 'export const value = 2\n')
  await writeFile(join(workspace, '.env'), 'SECRET=baru-jangan-bocor\n')
  execFileSync('git', ['add', 'app.ts', '.env'], { cwd: workspace })
  execFileSync('git', ['-c', 'user.name=Boo Test', '-c', 'user.email=boo@example.invalid', 'commit', '--quiet', '-m', 'change'], { cwd: workspace })

  const changed = await gitChangedFilesTool.run({ base: 'main' }, { workspace })
  assert.match(changed.content, /app\.ts/)
  assert.match(changed.content, /sensitive file omitted/)
  assert.doesNotMatch(changed.content, /\.env/)
  const diff = await gitDiffTool.run({ path: 'app.ts', base: 'main' }, { workspace })
  assert.match(diff.content, /-export const value = 1/)
  assert.match(diff.content, /\+export const value = 2/)
  assert.equal((await gitChangedFilesTool.run({ base: '--output=/tmp/evil' }, { workspace })).isError, true)
})
