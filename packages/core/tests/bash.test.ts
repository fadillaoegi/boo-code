import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Agent, type AgentEvent } from '../src/agent/loop.ts'
import type { Message, ToolCall } from '../src/domain/message.ts'
import type { NineRouterProvider } from '../src/provider/nineRouter.ts'
import { bashTool } from '../src/tools/bash.ts'
import { bashKillTool, bashOutputTool } from '../src/tools/bashOutput.ts'
import { createDefaultRegistry } from '../src/tools/index.ts'
import { cleanOutput, OutputBuffer, resolveShell } from '../src/tools/shell.ts'

const workspace = mkdtempSync(join(tmpdir(), 'boo-bash-'))
const ESC = String.fromCharCode(27)

function bash(command: string, extra: Record<string, unknown> = {}, context: Record<string, unknown> = {}) {
  return bashTool.run({ command, ...extra }, { workspace, ...context })
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(check: () => boolean, ms = 3_000): Promise<void> {
  const until = Date.now() + ms
  while (!check()) {
    if (Date.now() > until) throw new Error('kondisi tidak tercapai')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

test('shell: memakai shell pengguna bila kompatibel, selain itu bash, lalu sh', () => {
  const all = () => true
  assert.equal(resolveShell({ SHELL: '/bin/zsh' }, 'darwin', all).file, '/bin/zsh')
  assert.equal(resolveShell({ SHELL: '/usr/bin/fish' }, 'linux', all).file, '/bin/bash', 'fish tidak memahami sintaks POSIX')
  assert.equal(resolveShell({ SHELL: '/bin/zsh' }, 'linux', (path) => path === '/bin/sh').file, '/bin/sh', 'server tanpa zsh dan bash')
  assert.equal(resolveShell({}, 'linux', () => false).file, '/bin/sh')
  assert.equal(resolveShell({ ComSpec: 'C:\\Windows\\cmd.exe' }, 'win32', all).name, 'cmd')
})

test('keluaran panjang: awal dan akhir disimpan, tengahnya dicatat', () => {
  const buffer = new OutputBuffer(10, 10)
  for (let index = 0; index < 1_000; index += 1) buffer.append('x')
  buffer.append('AKHIR')
  const text = buffer.toString()
  assert.ok(text.startsWith('xxxxxxxxxx'))
  assert.ok(text.endsWith('xxxxxAKHIR'))
  assert.match(text, /985 karakter keluaran di tengah dilewati/)
})

test('warna dan bilah progres dibersihkan', () => {
  assert.equal(cleanOutput(`${ESC}[32mlulus${ESC}[0m\n10%\r50%\r100%\nselesai\r\n`), 'lulus\n100%\nselesai')
})

test('keluaran sangat besar tidak membuat perintah dianggap gagal', async () => {
  const result = await bash(`node -e "for (let i = 0; i < 20000; i++) console.log('baris ' + i)"`)
  assert.equal(result.isError, undefined)
  assert.match(result.content, /^baris 0\n/)
  assert.match(result.content, /baris 19999$/)
  assert.match(result.content, /dilewati/)
})

test('exit code bukan nol dilaporkan beserta keluarannya', async () => {
  const result = await bash('echo sebelum; exit 3')
  assert.equal(result.isError, true)
  assert.match(result.content, /exit 3[\s\S]*sebelum/)
})

test('masukan standar ditutup: perintah yang bertanya tidak menggantung', async () => {
  const started = Date.now()
  const result = await bash('read jawaban; echo "dapat:$jawaban"', { timeout: 10 })
  assert.ok(Date.now() - started < 3_000)
  assert.match(result.content, /dapat:/)
})

test('batas waktu dapat diatur, dan keluaran sejauh ini tetap dilaporkan', async () => {
  const started = Date.now()
  const result = await bash('echo mulai; sleep 20', { timeout: 1 })
  assert.ok(Date.now() - started < 4_000, `harus berhenti setelah 1 detik (${Date.now() - started} ms)`)
  assert.equal(result.isError, true)
  assert.match(result.content, /Waktu habis[\s\S]*1 detik[\s\S]*run_in_background[\s\S]*mulai/)
})

test('dihentikan pengguna: proses cucu ikut mati', async () => {
  const controller = new AbortController()
  let pid = 0
  const running = bash('sleep 30 & echo "pid:$!"; wait', {}, {
    signal: controller.signal,
    onOutput: (chunk: string) => {
      const match = /pid:(\d+)/.exec(chunk)
      if (match) pid = Number(match[1])
    },
  })
  await waitFor(() => pid > 0)
  assert.ok(alive(pid))
  controller.abort()
  const result = await running
  assert.match(result.content, /^Dibatalkan/)
  await waitFor(() => !alive(pid))
})

test('keluaran dialirkan selagi perintah berjalan', async () => {
  const seen: { chunk: string; at: number }[] = []
  const started = Date.now()
  await bash('echo satu; sleep 1; echo dua', {}, { onOutput: (chunk: string) => seen.push({ chunk, at: Date.now() - started }) })
  const first = seen.find((item) => item.chunk.includes('satu'))
  assert.ok(first && first.at < 800, 'baris pertama tiba sebelum perintah selesai')
})

test('latar belakang: langsung kembali, keluaran dibaca bertahap, lalu dihentikan', async () => {
  const started = Date.now()
  const start = await bash('echo siap; sleep 30', { run_in_background: true })
  assert.ok(Date.now() - started < 1_000)
  const id = /id (bg\d+)/.exec(start.content)?.[1]
  assert.ok(id, start.content)

  await new Promise((resolve) => setTimeout(resolve, 300))
  const output = (await bashOutputTool.run({ id }, { workspace })).content
  assert.match(output, /masih berjalan[\s\S]*siap/)
  assert.match((await bashOutputTool.run({ id }, { workspace })).content, /tidak ada keluaran baru/, 'yang sudah dibaca tidak diulang')

  assert.match((await bashKillTool.run({ id }, { workspace })).content, /dihentikan/)
  const unknown = await bashOutputTool.run({ id: 'bg999' }, { workspace })
  assert.equal(unknown.isError, true)
  assert.match(unknown.content, new RegExp(id))
})

test('agent meneruskan keluaran tool sebagai event sebelum tool selesai', async () => {
  const call: ToolCall = { id: 'c1', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: 'echo satu; sleep 0.3; echo dua' }) } }
  let turn = 0
  const provider = {
    model: 'palsu',
    stream() {
      turn += 1
      const message: Message = turn === 1
        ? { role: 'assistant', content: null, tool_calls: [call] }
        : { role: 'assistant', content: 'selesai' }
      // eslint-disable-next-line require-yield
      return (async function* reply() {
        return { finishReason: turn === 1 ? 'tool_calls' : 'stop', message }
      })()
    },
  } as unknown as NineRouterProvider
  const agent = new Agent({ provider, registry: createDefaultRegistry(), workspace, askPermission: async () => true })

  const events: AgentEvent[] = []
  for await (const event of agent.send('jalankan')) events.push(event)
  const outputs = events.filter((event) => event.type === 'tool-output')
  const end = events.findIndex((event) => event.type === 'tool-end')
  assert.ok(outputs.length >= 1)
  assert.ok(events.findIndex((event) => event.type === 'tool-output') < end)
  assert.match(outputs.map((event) => event.type === 'tool-output' ? event.chunk : '').join(''), /satu[\s\S]*dua/)
})
