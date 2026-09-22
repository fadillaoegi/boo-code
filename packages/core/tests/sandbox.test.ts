import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { commandEnvironment, resolveShell, runCommand } from '../src/tools/shell.ts'
import { inspectSandbox, resolveSandboxPolicy, sandboxLaunch } from '../src/tools/sandbox.ts'
import { Agent, type AgentEvent } from '../src/agent/loop.ts'
import type { Message, ToolCall } from '../src/domain/message.ts'
import type { NineRouterProvider } from '../src/provider/nineRouter.ts'
import { createDefaultRegistry } from '../src/tools/index.ts'
import { writeFileTool } from '../src/tools/writeFile.ts'

const shell = { file: '/bin/sh', name: 'sh', args: (command: string) => ['-c', command] }

test('kebijakan sandbox dibaca ketat dan network mati secara bawaan', () => {
  assert.deepEqual(resolveSandboxPolicy('read-only', 'true'), { mode: 'read-only', networkAccess: true })
  assert.deepEqual(resolveSandboxPolicy('tidak-valid', undefined), { mode: 'workspace-write', networkAccess: false })
  assert.deepEqual(resolveSandboxPolicy('danger-full-access', '0'), { mode: 'danger-full-access', networkAccess: false })
})

test('launcher macOS memakai Seatbelt dengan workspace dan path agent terlindungi', () => {
  const workspace = mkdtempSync(join(process.cwd(), '.sandbox-spec-'))
  mkdirSync(join(workspace, '.git'))
  try {
    const launch = sandboxLaunch(shell, 'echo ok', workspace, { mode: 'workspace-write' }, 'darwin', () => true)
    assert.equal(launch.file, '/usr/bin/sandbox-exec')
    assert.equal(launch.status.backend, 'seatbelt')
    assert.equal(launch.status.networkAccess, false)
    const profile = launch.args[1]
    assert.match(profile, /deny default/)
    assert.match(profile, new RegExp(workspace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.match(profile, /deny file-write\*/)
    assert.doesNotMatch(profile, /allow network\*/)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('launcher Linux memakai bubblewrap dan memutus network', () => {
  const workspace = process.cwd()
  const launch = sandboxLaunch(shell, 'echo ok', workspace, { mode: 'workspace-write' }, 'linux', (path) => path === '/usr/bin/bwrap')
  assert.equal(launch.file, '/usr/bin/bwrap')
  assert.equal(launch.status.backend, 'bubblewrap')
  assert.ok(launch.args.includes('--bind'))
  assert.ok(launch.args.includes('--unshare-net'))
})

test('platform tanpa backend melaporkan fallback, bukan mengaku sandbox aktif', () => {
  const linux = sandboxLaunch(shell, 'echo ok', process.cwd(), { mode: 'workspace-write' }, 'linux', () => false)
  assert.equal(linux.status.enforced, false)
  assert.match(linux.status.reason ?? '', /bwrap/)
  const windows = sandboxLaunch({ file: 'cmd.exe', name: 'cmd', args: () => [] }, '', process.cwd(), { mode: 'read-only' }, 'win32')
  assert.equal(windows.status.enforced, false)
  assert.match(windows.status.reason ?? '', /Windows/)
  const disabled = inspectSandbox(process.cwd(), { mode: 'danger-full-access' }, 'darwin')
  assert.equal(disabled.backend, 'none')
  assert.equal(disabled.enforced, false)
})

test('environment command membuang credential tetapi mempertahankan kebutuhan proses', () => {
  const cleaned = commandEnvironment({
    PATH: '/bin', HOME: '/tmp/home', LANG: 'en_US.UTF-8',
    NINEROUTER_KEY: 'rahasia', OPENAI_API_KEY: 'rahasia', GITHUB_TOKEN: 'rahasia', DATABASE_URL: 'rahasia',
  })
  assert.deepEqual(cleaned, { PATH: '/bin', HOME: '/tmp/home', LANG: 'en_US.UTF-8' })
})

test('write_file tidak dapat menyentuh metadata agent yang dilindungi', async () => {
  const workspace = mkdtempSync(join(process.cwd(), '.sandbox-tool-'))
  try {
    const result = await writeFileTool.run({ path: '.git/config', content: 'rusak' }, { workspace })
    assert.equal(result.isError, true)
    assert.match(result.content, /dilindungi/)
    assert.equal(existsSync(join(workspace, '.git', 'config')), false)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('mode read-only memblokir tool penulis sebelum meminta approval', async () => {
  const workspace = mkdtempSync(join(process.cwd(), '.sandbox-agent-'))
  const call: ToolCall = { id: 'w', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'baru.txt', content: 'x' }) } }
  let turn = 0
  let approvals = 0
  const provider = {
    model: 'palsu',
    stream() {
      turn += 1
      const message: Message = turn === 1
        ? { role: 'assistant', content: null, tool_calls: [call] }
        : { role: 'assistant', content: 'Tidak dapat menulis dalam mode read-only.' }
      // eslint-disable-next-line require-yield
      return (async function* reply() { return { finishReason: turn === 1 ? 'tool_calls' : 'stop', message } })()
    },
  } as unknown as NineRouterProvider
  const agent = new Agent({
    provider,
    registry: createDefaultRegistry(),
    workspace,
    sandbox: { mode: 'read-only' },
    askPermission: async () => { approvals += 1; return true },
  })
  const events: AgentEvent[] = []
  try {
    for await (const event of agent.send('buat file')) events.push(event)
    assert.equal(approvals, 0)
    assert.equal(existsSync(join(workspace, 'baru.txt')), false)
    assert.ok(events.some((event) => event.type === 'tool-end' && event.isError && /read-only/.test(event.content)))
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('Seatbelt mengizinkan write workspace, menolak sibling dan direktori terlindungi', { skip: process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec') }, async () => {
  const workspace = mkdtempSync(join(process.cwd(), '.sandbox-live-'))
  const inside = join(workspace, 'inside.txt')
  const sibling = `${workspace}-outside.txt`
  const protectedFile = join(workspace, '.git', 'config')
  mkdirSync(join(workspace, '.git'))
  writeFileSync(protectedFile, 'aman\n')
  try {
    const result = await runCommand(`touch ${JSON.stringify(inside)}; touch ${JSON.stringify(sibling)}; echo rusak > ${JSON.stringify(protectedFile)}`, {
      cwd: workspace,
      shell: resolveShell(),
      sandbox: { mode: 'workspace-write' },
      timeoutMs: 5_000,
    })
    assert.equal(result.sandbox.backend, 'seatbelt')
    assert.equal(existsSync(inside), true)
    assert.equal(existsSync(sibling), false)
    assert.match(result.output, /Operation not permitted/)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
    rmSync(sibling, { force: true })
  }
})

test('Seatbelt read-only menolak write di workspace', { skip: process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec') }, async () => {
  const workspace = mkdtempSync(join(process.cwd(), '.sandbox-readonly-'))
  const target = join(workspace, 'blocked.txt')
  try {
    const result = await runCommand(`touch ${JSON.stringify(target)}`, {
      cwd: workspace,
      shell: resolveShell(),
      sandbox: { mode: 'read-only' },
      timeoutMs: 5_000,
    })
    assert.notEqual(result.exitCode, 0)
    assert.equal(existsSync(target), false)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('Seatbelt memblokir network secara bawaan dan membukanya hanya saat diminta', { skip: process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec') }, async () => {
  const server = createServer((socket) => socket.end())
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const script = `const s=require('net').connect(${address.port},'127.0.0.1');s.on('connect',()=>process.exit(0));s.on('error',e=>{console.error(e.code);process.exit(3)})`
  try {
    const blocked = await runCommand(`node -e ${JSON.stringify(script)}`, {
      cwd: process.cwd(), shell: resolveShell(), sandbox: { mode: 'workspace-write' }, timeoutMs: 5_000,
    })
    assert.notEqual(blocked.exitCode, 0)
    const allowed = await runCommand(`node -e ${JSON.stringify(script)}`, {
      cwd: process.cwd(), shell: resolveShell(), sandbox: { mode: 'workspace-write', networkAccess: true }, timeoutMs: 5_000,
    })
    assert.equal(allowed.exitCode, 0, allowed.output)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
