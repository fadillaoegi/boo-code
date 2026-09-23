import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Agent } from '../src/agent/loop.ts'
import { composeSystemPrompt, instructionTargetsForTool, loadInstructions, MAX_INSTRUCTION_BYTES, SCOPED_INSTRUCTIONS_TOOL_RESULT } from '../src/agent/instructions.ts'
import type { Message, ToolCall } from '../src/domain/message.ts'
import { createRegistry, type Tool } from '../src/domain/tool.ts'
import type { NineRouterProvider } from '../src/provider/nineRouter.ts'
import { createDefaultRegistry } from '../src/tools/index.ts'

function tempDir(name: string): string {
  return mkdtempSync(join(tmpdir(), `boo-aturan-${name}-`))
}

/** Repo git dengan subdirektori paket, seperti monorepo. */
function monorepo() {
  const root = tempDir('repo')
  mkdirSync(join(root, '.git'))
  const pkg = join(root, 'packages', 'web')
  mkdirSync(pkg, { recursive: true })
  return { root, pkg }
}

test('tanpa berkas aturan, prompt sistem tidak berubah', () => {
  const { root } = monorepo()
  const files = loadInstructions({ workspace: root, home: tempDir('home') })
  assert.deepEqual(files, [])
  assert.equal(composeSystemPrompt('DASAR', files), 'DASAR')
})

test('aturan pribadi, akar repo, lalu paket: dari yang paling umum ke yang paling spesifik', () => {
  const { root, pkg } = monorepo()
  const home = tempDir('home')
  mkdirSync(join(home, '.boo'))
  writeFileSync(join(home, '.boo', 'BOO.md'), 'jawab singkat')
  writeFileSync(join(root, 'AGENTS.md'), 'pakai pnpm')
  writeFileSync(join(pkg, 'BOO.md'), 'komponen pakai React')

  const files = loadInstructions({ workspace: pkg, home })
  assert.deepEqual(files.map((file) => file.label), ['~/.boo/BOO.md', '../../AGENTS.md', 'BOO.md'])
  const prompt = composeSystemPrompt('DASAR', files)
  assert.ok(prompt.indexOf('jawab singkat') < prompt.indexOf('pakai pnpm'))
  assert.ok(prompt.indexOf('pakai pnpm') < prompt.indexOf('komponen pakai React'))
})

test('satu berkas per direktori: BOO.md didahulukan dari AGENTS.md dan CLAUDE.md', () => {
  const { root } = monorepo()
  writeFileSync(join(root, 'CLAUDE.md'), 'dari claude')
  writeFileSync(join(root, 'AGENTS.md'), 'dari agents')
  assert.deepEqual(loadInstructions({ workspace: root }).map((file) => file.content), ['dari agents'])
  writeFileSync(join(root, 'BOO.md'), 'dari boo')
  assert.deepEqual(loadInstructions({ workspace: root }).map((file) => file.content), ['dari boo'])
})

test('di luar repo git, direktori induk tidak ikut dibaca', () => {
  const parent = tempDir('bukan-repo')
  writeFileSync(join(parent, 'BOO.md'), 'aturan induk yang asing')
  const workspace = join(parent, 'proyek')
  mkdirSync(workspace)
  assert.deepEqual(loadInstructions({ workspace }), [])
})

test('symlink ke luar repo atau ke berkas rahasia tidak diikuti', () => {
  const { root, pkg } = monorepo()
  const outside = tempDir('luar')
  writeFileSync(join(outside, 'kunci.txt'), 'AKIA-RAHASIA')
  symlinkSync(join(outside, 'kunci.txt'), join(root, 'BOO.md'))
  writeFileSync(join(root, '.env'), 'TOKEN=rahasia')
  symlinkSync(join(root, '.env'), join(pkg, 'BOO.md'))

  const files = loadInstructions({ workspace: pkg })
  assert.deepEqual(files, [])
})

test('aturan yang terlalu panjang dipotong dan ditandai', () => {
  const { root, pkg } = monorepo()
  writeFileSync(join(root, 'BOO.md'), 'a'.repeat(MAX_INSTRUCTION_BYTES - 10))
  writeFileSync(join(pkg, 'BOO.md'), 'b'.repeat(100))
  const files = loadInstructions({ workspace: pkg })
  assert.equal(files.length, 2)
  assert.equal(files[1].truncated, true)
  assert.equal(files.reduce((total, file) => total + file.content.length, 0), MAX_INSTRUCTION_BYTES)
  assert.match(composeSystemPrompt('DASAR', files), /Truncated/)
})

test('agent memuat aturan ke prompt sistem dan memuat ulang bila berkasnya berubah', async () => {
  const { root } = monorepo()
  writeFileSync(join(root, 'BOO.md'), 'versi satu')
  const seen: Message[][] = []
  const provider = {
    model: 'palsu',
    stream(messages: Message[]) {
      seen.push(messages.map((message) => ({ ...message })))
      return (async function* reply() {
        yield { type: 'text' as const, delta: 'ok' }
        return { finishReason: 'stop', message: { role: 'assistant' as const, content: 'ok' } }
      })()
    },
  } as unknown as NineRouterProvider
  const agent = new Agent({
    provider,
    registry: createDefaultRegistry(),
    workspace: root,
    askPermission: async () => true,
    instructions: () => loadInstructions({ workspace: root }),
  })

  const types = async (input: string) => {
    const list: string[] = []
    for await (const event of agent.send(input)) list.push(event.type)
    return list
  }

  assert.ok(!(await types('satu')).includes('instructions-reloaded'), 'tidak ada perubahan, tidak ada pemberitahuan')
  assert.match(String(seen[0][0].content), /versi satu/)

  writeFileSync(join(root, 'BOO.md'), 'versi dua')
  assert.equal((await types('dua'))[0], 'instructions-reloaded')
  assert.match(String(seen[1][0].content), /versi dua/)
  assert.doesNotMatch(String(seen[1][0].content), /versi satu/)
  assert.equal(agent.history.filter((message) => message.role === 'system').length, 1)
})

test('target nested memuat aturan scoped tanpa menerapkannya ke sibling', () => {
  const { root } = monorepo()
  const ui = join(root, 'packages', 'ui')
  const api = join(root, 'packages', 'api')
  mkdirSync(ui, { recursive: true })
  mkdirSync(api, { recursive: true })
  writeFileSync(join(root, 'BOO.md'), 'aturan root')
  writeFileSync(join(ui, 'AGENTS.md'), 'khusus UI')
  writeFileSync(join(api, 'AGENTS.md'), 'khusus API')

  const files = loadInstructions({ workspace: root, targets: ['packages/ui/button.ts'] })
  assert.deepEqual(files.map((file) => [file.label, file.scope]), [
    ['BOO.md', undefined],
    ['packages/ui/AGENTS.md', 'packages/ui'],
  ])
  const prompt = composeSystemPrompt('DASAR', files)
  assert.match(prompt, /packages\/ui\/AGENTS\.md \(scope: packages\/ui\/\*\*\)/)
  assert.match(prompt, /khusus UI/)
  assert.doesNotMatch(prompt, /khusus API/)
})

test('target tool mencakup path tunggal, daftar path, dan file dalam apply_patch', () => {
  assert.deepEqual(instructionTargetsForTool('read_file', { path: 'src/a.ts' }), ['src/a.ts'])
  assert.deepEqual(instructionTargetsForTool('git_commit', { paths: ['a.ts', 'b.ts'] }), ['a.ts', 'b.ts'])
  assert.deepEqual(instructionTargetsForTool('test_impact', { changed_files: ['src/a.ts'] }), ['src/a.ts'])
  assert.deepEqual(instructionTargetsForTool('change_impact', { changed_files: ['src/a.ts'] }), ['src/a.ts'])
  assert.deepEqual(instructionTargetsForTool('apply_patch', { patch: [
    '*** Begin Patch',
    '*** Update File: packages/ui/a.ts',
    '*** Add File: packages/api/b.ts',
    '*** End Patch',
  ].join('\n') }), ['packages/ui/a.ts', 'packages/api/b.ts'])
})

function call(id: string, args: object): ToolCall {
  return { id, type: 'function', function: { name: 'write_file', arguments: JSON.stringify(args) } }
}

test('agent menunda tool pertama sampai aturan target nested masuk ke system prompt', async () => {
  const { root } = monorepo()
  const ui = join(root, 'packages', 'ui')
  mkdirSync(ui, { recursive: true })
  writeFileSync(join(root, 'BOO.md'), 'aturan root')
  writeFileSync(join(ui, 'AGENTS.md'), 'Gunakan komponen aksesibel.')
  let approvals = 0
  let runs = 0
  const tool: Tool = {
    name: 'write_file', description: 'write', risk: 'confirm', writesWorkspace: true,
    schema: { type: 'function', function: { name: 'write_file', description: 'write', parameters: {
      type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'],
    } } },
    preview: (args) => `write ${(args as { path: string }).path}`,
    async run() { runs += 1; return { content: 'ok' } },
  }
  const seen: Message[][] = []
  let step = 0
  const provider = {
    model: 'palsu',
    stream(messages: Message[]) {
      seen.push(messages.map((message) => ({ ...message })))
      const message: Message = step++ < 2
        ? { role: 'assistant', content: null, tool_calls: [call(`call-${step}`, { path: 'packages/ui/button.ts', content: 'isi' })] }
        : { role: 'assistant', content: 'selesai' }
      // eslint-disable-next-line require-yield
      return (async function* reply() { return { finishReason: message.tool_calls ? 'tool_calls' : 'stop', message } })()
    },
  } as unknown as NineRouterProvider
  const agent = new Agent({
    provider, registry: createRegistry([tool]), workspace: root,
    instructions: (targets) => loadInstructions({ workspace: root, targets }),
    askPermission: async () => { approvals += 1; return true },
  })
  const types: string[] = []
  for await (const event of agent.send('buat komponen')) types.push(event.type)

  assert.equal(runs, 1)
  assert.equal(approvals, 1)
  assert.ok(types.includes('instructions-reloaded'))
  assert.doesNotMatch(seen[0][0].content ?? '', /Gunakan komponen aksesibel/)
  assert.match(seen[1][0].content ?? '', /scope: packages\/ui\/\*\*/)
  assert.match(seen[1][0].content ?? '', /Gunakan komponen aksesibel/)
  assert.ok(agent.history.some((message) => message.role === 'tool' && message.content === SCOPED_INSTRUCTIONS_TOOL_RESULT))
  assert.equal(agent.history.at(-1)?.content, 'selesai')
})

test('@path memuat aturan scoped sebelum panggilan model pertama', async () => {
  const { root } = monorepo()
  const ui = join(root, 'packages', 'ui')
  mkdirSync(ui, { recursive: true })
  writeFileSync(join(ui, 'AGENTS.md'), 'Aturan referensi UI.')
  writeFileSync(join(ui, 'input.ts'), 'export const input = true\n')
  const seen: Message[][] = []
  const provider = {
    model: 'palsu',
    stream(messages: Message[]) {
      seen.push(messages.map((message) => ({ ...message })))
      // eslint-disable-next-line require-yield
      return (async function* reply() { return { finishReason: 'stop', message: { role: 'assistant' as const, content: 'ok' } } })()
    },
  } as unknown as NineRouterProvider
  const agent = new Agent({
    provider, registry: createDefaultRegistry(), workspace: root,
    instructions: (targets) => loadInstructions({ workspace: root, targets }), askPermission: async () => true,
  })
  const types: string[] = []
  for await (const event of agent.send('jelaskan @packages/ui/input.ts')) types.push(event.type)
  assert.equal(types[0], 'instructions-reloaded')
  assert.match(seen[0][0].content ?? '', /Aturan referensi UI/)
})
