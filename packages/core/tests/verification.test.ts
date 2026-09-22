import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Agent, type AgentEvent } from '../src/agent/loop.ts'
import { CHANGE_RISK_VERIFICATION_MARK, isVerificationCommand } from '../src/agent/verification.ts'
import type { Message, ToolCall } from '../src/domain/message.ts'
import { createRegistry, type Tool, type ToolRegistry } from '../src/domain/tool.ts'
import type { NineRouterProvider } from '../src/provider/nineRouter.ts'
import { createDefaultRegistry } from '../src/tools/index.ts'
import { writeFileTool } from '../src/tools/writeFile.ts'

function call(id: string, name: string, args: object): ToolCall {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}

function scripted(steps: Message[], seen: Message[][] = []): NineRouterProvider {
  let index = 0
  return {
    model: 'palsu',
    stream(messages: Message[]) {
      seen.push(messages.map((message) => ({ ...message })))
      const message = steps[Math.min(index, steps.length - 1)]
      index += 1
      return (async function* reply() {
        if (message.content) yield { type: 'text' as const, delta: message.content }
        return { finishReason: message.tool_calls?.length ? 'tool_calls' : 'stop', message }
      })()
    },
  } as unknown as NineRouterProvider
}

async function run(steps: Message[], seen: Message[][] = [], registry: ToolRegistry = createDefaultRegistry()): Promise<{ events: AgentEvent[]; agent: Agent }> {
  const workspace = mkdtempSync(join(tmpdir(), 'boo-verification-'))
  const agent = new Agent({
    provider: scripted(steps, seen),
    registry,
    workspace,
    askPermission: async () => true,
  })
  const events: AgentEvent[] = []
  for await (const event of agent.send('buat app')) events.push(event)
  return { events, agent }
}

test('mengenali command verifikasi, bukan sekadar kata test', () => {
  assert.equal(isVerificationCommand('pnpm test'), true)
  assert.equal(isVerificationCommand('npm run lint && npm run typecheck'), true)
  assert.equal(isVerificationCommand('pnpm exec vue-tsc --noEmit'), true)
  assert.equal(isVerificationCommand('go test ./...'), true)
  assert.equal(isVerificationCommand('git diff --check'), true)
  assert.equal(isVerificationCommand('echo test'), false)
  assert.equal(isVerificationCommand('printf "lint nanti"'), false)
})

test('setelah edit, agent diingatkan dan verifikasi sukses menuntaskan pekerjaan', async () => {
  const seen: Message[][] = []
  const { events, agent } = await run([
    { role: 'assistant', content: null, tool_calls: [call('w', 'write_file', { path: 'app.js', content: 'const value = 1\n' })] },
    { role: 'assistant', content: null, tool_calls: [call('v', 'bash', { command: 'node --check app.js' })] },
    { role: 'assistant', content: 'Selesai dan sudah diperiksa.' },
  ], seen)

  assert.equal(events.filter((event) => event.type === 'verification-needed').length, 1)
  assert.equal(events.some((event) => event.type === 'verification-incomplete'), false)
  assert.deepEqual(events.filter((event) => event.type === 'verification-state').map((event) => event.status), ['needed', 'complete'])
  assert.ok(seen[1].some((message) => message.role === 'system' && /Completion verification/.test(message.content ?? '')))
  assert.equal(agent.history.filter((message) => message.role === 'system').length, 1, 'pengingat internal tidak disimpan ke sesi')
})

test('pengingat menyertakan test terdampak dan command yang terdeteksi', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'boo-verification-impact-'))
  mkdirSync(join(workspace, 'src'))
  writeFileSync(join(workspace, 'src', 'cart.ts'), 'export const total = 1\n')
  writeFileSync(join(workspace, 'src', 'cart.test.ts'), "import { total } from './cart'\nvoid total\n")
  writeFileSync(join(workspace, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }))
  const seen: Message[][] = []
  const agent = new Agent({
    provider: scripted([
      { role: 'assistant', content: null, tool_calls: [call('w', 'write_file', { path: 'src/cart.ts', content: 'export const total = 2\n' })] },
      { role: 'assistant', content: 'Selesai.' },
    ], seen),
    registry: createDefaultRegistry(), workspace, askPermission: async () => true, autoReview: false,
  })
  const events: AgentEvent[] = []
  for await (const event of agent.send('ubah total')) events.push(event)

  const needed = events.find((event): event is Extract<AgentEvent, { type: 'verification-needed' }> => event.type === 'verification-needed')
  assert.deepEqual(needed?.tests, ['src/cart.test.ts'])
  assert.deepEqual(needed?.commands, ['npm run test'])
  const reminder = seen[1].find((message) => message.role === 'system' && /Completion verification/.test(message.content ?? ''))?.content ?? ''
  assert.match(reminder, /Test terkait yang ditemukan: src\/cart\.test\.ts/)
  assert.match(reminder, /npm run test/)
  assert.match(reminder, /belum dijalankan/)
})

test('kesimpulan tanpa pemeriksaan ditandai sebagai belum terverifikasi', async () => {
  const { events } = await run([
    { role: 'assistant', content: null, tool_calls: [call('w', 'write_file', { path: 'app.js', content: 'const value = 1\n' })] },
    { role: 'assistant', content: 'Sudah selesai.' },
  ])

  const incomplete = events.find((event): event is Extract<AgentEvent, { type: 'verification-incomplete' }> => event.type === 'verification-incomplete')
  assert.deepEqual(incomplete, { type: 'verification-incomplete', files: ['app.js'], attempted: false })
})

test('pemeriksaan gagal tidak dianggap sebagai bukti keberhasilan', async () => {
  const { events } = await run([
    { role: 'assistant', content: null, tool_calls: [call('w', 'write_file', { path: 'app.js', content: 'const value = 1\n' })] },
    { role: 'assistant', content: null, tool_calls: [call('v', 'bash', { command: 'node --check tidak-ada.js' })] },
    { role: 'assistant', content: 'Saya berhenti.' },
  ])

  const incomplete = events.find((event): event is Extract<AgentEvent, { type: 'verification-incomplete' }> => event.type === 'verification-incomplete')
  assert.equal(incomplete?.attempted, true)
})

test('edit setelah test mewajibkan verifikasi ulang', async () => {
  const { events } = await run([
    { role: 'assistant', content: null, tool_calls: [call('w', 'write_file', { path: 'app.js', content: 'const value = 1\n' })] },
    { role: 'assistant', content: null, tool_calls: [call('v1', 'bash', { command: 'node --check app.js' })] },
    { role: 'assistant', content: null, tool_calls: [call('e', 'edit_file', { path: 'app.js', old_text: '1', new_text: '2' })] },
    { role: 'assistant', content: null, tool_calls: [call('v2', 'bash', { command: 'node --check app.js' })] },
    { role: 'assistant', content: 'Selesai.' },
  ])

  assert.equal(events.filter((event) => event.type === 'verification-needed').length, 2)
  assert.equal(events.some((event) => event.type === 'verification-incomplete'), false)
  assert.deepEqual(events.filter((event) => event.type === 'verification-state').map((event) => event.status), ['needed', 'complete', 'needed', 'complete'])
})

test('diagnostics sukses dihitung sebagai bukti verifikasi', async () => {
  const fakeDiagnostics: Tool = {
    name: 'diagnostics',
    description: 'test diagnostics',
    risk: 'confirm',
    writesWorkspace: true,
    runsCommand: true,
    verifiesWorkspace: true,
    schema: { type: 'function', function: { name: 'diagnostics', description: 'test', parameters: { type: 'object', properties: {} } } },
    preview: () => 'diagnostics',
    async run() { return { content: 'semua diagnostics lulus' } },
  }
  const { events } = await run([
    { role: 'assistant', content: null, tool_calls: [call('w', 'write_file', { path: 'app.js', content: 'const value = 1\n' })] },
    { role: 'assistant', content: null, tool_calls: [call('d', 'diagnostics', {})] },
    { role: 'assistant', content: 'Selesai.' },
  ], [], createRegistry([writeFileTool, fakeDiagnostics] as never))

  assert.equal(events.filter((event) => event.type === 'verification-needed').length, 1)
  assert.equal(events.some((event) => event.type === 'verification-incomplete'), false)
})

test('diff high-risk meminta verifikasi substantif setelah pemeriksaan dasar', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'boo-risk-verification-'))
  const seen: Message[][] = []
  const fakeBash: Tool = {
    name: 'bash', description: 'command', risk: 'safe', runsCommand: true,
    schema: { type: 'function', function: { name: 'bash', description: 'command', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
    preview: () => 'command', async run() { return { content: 'ok' } },
  }
  const fakeDiagnostics: Tool = {
    name: 'diagnostics', description: 'verify', risk: 'safe', runsCommand: true, verifiesWorkspace: true,
    schema: { type: 'function', function: { name: 'diagnostics', description: 'verify', parameters: { type: 'object', properties: {} } } },
    preview: () => 'verify', async run() { return { content: 'ok' } },
  }
  const agent = new Agent({
    provider: scripted([
      { role: 'assistant', content: null, tool_calls: [call('w', 'write_file', { path: 'src/auth/session.ts', content: 'export const allowed = false\n' })] },
      { role: 'assistant', content: null, tool_calls: [call('basic', 'bash', { command: 'git diff --check' })] },
      { role: 'assistant', content: 'Selesai.' },
      { role: 'assistant', content: null, tool_calls: [call('strong', 'diagnostics', {})] },
      { role: 'assistant', content: 'Selesai setelah diagnostics.' },
    ], seen),
    registry: createRegistry([writeFileTool, fakeBash, fakeDiagnostics] as never),
    workspace, askPermission: async () => true, autoReview: false,
  })
  const events: AgentEvent[] = []
  for await (const event of agent.send('ubah satu nilai')) events.push(event)

  const risk = events.find((event): event is Extract<AgentEvent, { type: 'risk-assessed' }> => event.type === 'risk-assessed')
  assert.equal(risk?.assessment.level, 'high')
  assert.equal(events.some((event) => event.type === 'risk-verification-weak'), false)
  assert.ok(seen[3].some((message) => message.role === 'user' && message.content?.startsWith(CHANGE_RISK_VERIFICATION_MARK)))
  assert.equal(agent.history.at(-1)?.content, 'Selesai setelah diagnostics.')
})

test('high-risk tanpa pemeriksaan kuat berhenti mengingatkan dan melaporkan bukti lemah', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'boo-risk-verification-'))
  const fakeBash: Tool = {
    name: 'bash', description: 'command', risk: 'safe', runsCommand: true,
    schema: { type: 'function', function: { name: 'bash', description: 'command', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
    preview: () => 'command', async run() { return { content: 'ok' } },
  }
  const agent = new Agent({
    provider: scripted([
      { role: 'assistant', content: null, tool_calls: [call('w', 'write_file', { path: 'migrations/001.sql', content: 'ALTER TABLE users ADD COLUMN role TEXT;\n' })] },
      { role: 'assistant', content: null, tool_calls: [call('basic', 'bash', { command: 'git diff --check' })] },
      { role: 'assistant', content: 'Selesai.' },
      { role: 'assistant', content: 'Tidak ada test proyek.' },
    ]),
    registry: createRegistry([writeFileTool, fakeBash] as never),
    workspace, askPermission: async () => true, autoReview: false,
  })
  const events: AgentEvent[] = []
  for await (const event of agent.send('buat migrasi')) events.push(event)

  assert.equal(events.filter((event) => event.type === 'risk-assessed').length, 1)
  assert.equal(events.filter((event) => event.type === 'risk-verification-weak').length, 1)
  assert.equal(agent.history.at(-1)?.content, 'Tidak ada test proyek.')
})
