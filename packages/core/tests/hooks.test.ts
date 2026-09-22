import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Agent } from '../src/agent/loop.ts'
import { HOOK_COMPLETION_MARK, hookMatches, loadHooks, parseHooks, runHookCommand, type HookDefinition } from '../src/agent/hooks.ts'
import type { Message } from '../src/domain/message.ts'
import { buildTranscript } from '../src/presentation/transcript.ts'
import type { NineRouterProvider } from '../src/provider/nineRouter.ts'
import { createDefaultRegistry } from '../src/tools/index.ts'

function definition(overrides: Partial<HookDefinition> = {}): HookDefinition {
  return {
    id: 'check', event: 'before_tool', matcher: 'write_*', command: 'echo ok',
    timeoutSeconds: 5, mutatesWorkspace: false, verifiesWorkspace: false,
    source: 'project', label: '.boo/hooks.json', ...overrides,
  }
}

test('parser memvalidasi hook, matcher wildcard bekerja, dan proyek menimpa global', () => {
  const parsed = parseHooks({ hooks: {
    before_tool: [{ id: 'guard', matcher: 'write_*', command: 'echo guard', timeout: 999 }],
    after_tool: [{ id: 'invalid command', command: 'echo no' }],
    on_complete: [{ id: 'test', command: 'pnpm test', verifies_workspace: true }],
  } }, 'project', '.boo/hooks.json')
  assert.equal(parsed.length, 2)
  assert.equal(parsed[0].timeoutSeconds, 120)
  assert.equal(hookMatches(parsed[0], 'before_tool', 'write_file'), true)
  assert.equal(hookMatches(parsed[0], 'before_tool', 'read_file'), false)

  const root = mkdtempSync(join(tmpdir(), 'boo-hooks-repo-'))
  const home = mkdtempSync(join(tmpdir(), 'boo-hooks-home-'))
  mkdirSync(join(root, '.git'))
  mkdirSync(join(root, '.boo'))
  mkdirSync(join(home, '.boo'))
  writeFileSync(join(home, '.boo', 'hooks.json'), JSON.stringify({ hooks: { before_tool: [{ id: 'guard', command: 'echo global' }] } }))
  writeFileSync(join(root, '.boo', 'hooks.json'), JSON.stringify({ hooks: { before_tool: [{ id: 'guard', command: 'echo project' }] } }))
  assert.equal(loadHooks(root, home).find((hook) => hook.id === 'guard')?.command, 'echo project')
})

test('symlink konfigurasi keluar root diabaikan dan command hook dijalankan', async () => {
  const root = mkdtempSync(join(tmpdir(), 'boo-hooks-safe-'))
  const outside = join(mkdtempSync(join(tmpdir(), 'boo-hooks-outside-')), 'hooks.json')
  mkdirSync(join(root, '.git'))
  mkdirSync(join(root, '.boo'))
  writeFileSync(outside, JSON.stringify({ hooks: { on_complete: [{ id: 'evil', command: 'echo evil' }] } }))
  symlinkSync(outside, join(root, '.boo', 'hooks.json'))
  assert.deepEqual(loadHooks(root), [])

  const result = await runHookCommand(definition({ event: 'on_complete', matcher: '*', command: 'echo hook-ok' }), {
    workspace: root, sandbox: { mode: 'danger-full-access' },
  })
  assert.equal(result.success, true)
  assert.equal(result.content, 'hook-ok')
})

test('before_tool gagal memblokir tool dan hasilnya dikirim ke model', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'boo-hook-before-'))
  writeFileSync(join(workspace, 'data.txt'), 'rahasia implementasi')
  const seen: Message[][] = []
  let turn = 0
  const provider = {
    model: 'hook-model',
    // eslint-disable-next-line require-yield
    async *stream(messages: Message[]) {
      seen.push(messages.map((message) => ({ ...message })))
      turn += 1
      if (turn === 1) return {
        finishReason: 'tool_calls',
        message: { role: 'assistant' as const, content: null, tool_calls: [{
          id: 'read', type: 'function' as const,
          function: { name: 'read_file', arguments: JSON.stringify({ path: 'data.txt' }) },
        }] },
      }
      return { finishReason: 'stop', message: { role: 'assistant' as const, content: 'Diblokir.' } }
    },
  } as unknown as NineRouterProvider
  const agent = new Agent({
    provider, registry: createDefaultRegistry(), workspace,
    askPermission: async () => true,
    hooks: () => [definition({ matcher: 'read_file', command: 'echo kebijakan-gagal; exit 2' })],
    sandbox: { mode: 'danger-full-access' }, verifyCompletion: false,
  })
  for await (const event of agent.send('baca data')) void event
  const result = seen[1].find((message) => message.role === 'tool')?.content ?? ''
  assert.match(result, /Diblokir lifecycle hook/)
  assert.match(result, /kebijakan-gagal/)
  assert.doesNotMatch(result, /rahasia implementasi/)
})

test('after_tool gagal menandai hasil tool sebagai error dan mengirim laporannya ke model', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'boo-hook-after-'))
  writeFileSync(join(workspace, 'data.txt'), 'isi boleh dibaca')
  const seen: Message[][] = []
  const events: Array<{ type: string; isError?: boolean }> = []
  let turn = 0
  const provider = {
    model: 'hook-model',
    // eslint-disable-next-line require-yield
    async *stream(messages: Message[]) {
      seen.push(messages.map((message) => ({ ...message })))
      turn += 1
      if (turn === 1) return {
        finishReason: 'tool_calls',
        message: { role: 'assistant' as const, content: null, tool_calls: [{
          id: 'read', type: 'function' as const,
          function: { name: 'read_file', arguments: JSON.stringify({ path: 'data.txt' }) },
        }] },
      }
      return { finishReason: 'stop', message: { role: 'assistant' as const, content: 'Hook ditangani.' } }
    },
  } as unknown as NineRouterProvider
  const agent = new Agent({
    provider, registry: createDefaultRegistry(), workspace,
    askPermission: async () => true,
    hooks: () => [definition({ event: 'after_tool', matcher: 'read_file', command: 'echo pemeriksaan-gagal; exit 3' })],
    sandbox: { mode: 'danger-full-access' }, verifyCompletion: false,
  })
  for await (const event of agent.send('baca data')) events.push(event)
  const result = seen[1].find((message) => message.role === 'tool')?.content ?? ''
  assert.match(result, /isi boleh dibaca/)
  assert.match(result, /Lifecycle hooks after_tool/)
  assert.match(result, /pemeriksaan-gagal/)
  assert.equal(events.find((event) => event.type === 'tool-end')?.isError, true)
})

test('on_complete gagal meminta model memperbaiki lalu dijalankan ulang hingga sukses', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'boo-hook-complete-'))
  const seen: Message[][] = []
  const provider = {
    model: 'hook-model',
    // eslint-disable-next-line require-yield
    async *stream(messages: Message[]) {
      seen.push(messages.map((message) => ({ ...message })))
      return { finishReason: 'stop', message: { role: 'assistant' as const, content: seen.length === 1 ? 'Selesai awal.' : 'Selesai setelah hook.' } }
    },
  } as unknown as NineRouterProvider
  const hook = definition({
    event: 'on_complete', matcher: '*',
    command: 'if [ -f .hook-pass ]; then exit 0; else touch .hook-pass; echo perbaiki-dulu; exit 1; fi',
    mutatesWorkspace: true,
  })
  const agent = new Agent({
    provider, registry: createDefaultRegistry(), workspace,
    askPermission: async () => true, hooks: () => [hook],
    sandbox: { mode: 'danger-full-access' }, verifyCompletion: false,
  })
  for await (const event of agent.send('selesaikan')) void event
  assert.equal(seen.length, 2)
  const feedback = seen[1].findLast((message) => message.role === 'user')?.content ?? ''
  assert.ok(feedback.startsWith(HOOK_COMPLETION_MARK))
  assert.match(feedback, /perbaiki-dulu/)
  assert.equal(agent.history.at(-1)?.content, 'Selesai setelah hook.')

  const transcript = buildTranscript(agent.history).flat()
  assert.equal(transcript.some((item) => item.kind === 'user' && item.text.includes(HOOK_COMPLETION_MARK)), false)
  assert.match(transcript.find((item) => item.kind === 'notice')?.text ?? '', /Hook on_complete meminta perbaikan/)
})
