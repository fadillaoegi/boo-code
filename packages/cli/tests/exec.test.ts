import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createDefaultRegistry, type SandboxStatus } from '@boo/core'
import { approveHeadlessAction, parseExecArguments } from '../src/exec.ts'

test('parser exec mendukung prompt, stdin mode, JSON, dan approval eksplisit', () => {
  assert.deepEqual(parseExecArguments(['--json', '--full-auto', '--ephemeral', '--model', 'model-a', 'perbaiki', 'test']), {
    prompt: 'perbaiki test', json: true, ephemeral: true, approval: 'workspace',
    model: 'model-a', effort: undefined, sandbox: undefined, images: [], help: false,
  })
  assert.equal(parseExecArguments(['--approval=never']).prompt, '')
  assert.throws(() => parseExecArguments(['--approval', 'semua']), /tidak sah/)
  assert.throws(() => parseExecArguments(['--sandbox', 'bebas']), /tidak sah/)
  assert.throws(() => parseExecArguments(['--asing']), /tidak dikenal/)
})

test('full-auto hanya mengizinkan perubahan workspace dan command yang tersandbox', () => {
  const registry = createDefaultRegistry()
  const enforced: SandboxStatus = { mode: 'workspace-write', backend: 'seatbelt', enforced: true, networkAccess: false }
  const fallback: SandboxStatus = { mode: 'workspace-write', backend: 'none', enforced: false, networkAccess: false }
  const networked: SandboxStatus = { mode: 'workspace-write', backend: 'seatbelt', enforced: true, networkAccess: true }
  assert.equal(approveHeadlessAction('write_file', 'never', registry, enforced), false)
  assert.equal(approveHeadlessAction('write_file', 'workspace', registry, fallback), true)
  assert.equal(approveHeadlessAction('bash', 'workspace', registry, enforced), true)
  assert.equal(approveHeadlessAction('bash', 'workspace', registry, fallback), false)
  assert.equal(approveHeadlessAction('bash', 'workspace', registry, networked), false)
  assert.equal(approveHeadlessAction('bash_input', 'workspace', registry, enforced), false)
  assert.equal(approveHeadlessAction('git_commit', 'workspace', registry, enforced), false)
  assert.equal(approveHeadlessAction('mcp_call', 'workspace', registry, enforced), false)
  assert.equal(approveHeadlessAction('open_app', 'workspace', registry, enforced), false)
  assert.equal(approveHeadlessAction('whatsapp_send_message', 'workspace', registry, enforced), false)
  assert.equal(approveHeadlessAction('memory_add', 'workspace', registry, enforced), false)
})

test('boo-code exec JSONL menjalankan task Auto dan memberi hasil terstruktur', { timeout: 30_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'boo-cli-exec-'))
  const imagePath = join(directory, 'ui.png')
  writeFileSync(imagePath, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('exec-image')]))
  const requests: Array<{ model: string; tools?: unknown[]; messages?: Array<{ content?: unknown }> }> = []
  const server = createServer(async (request, response) => {
    if (request.url === '/v1/models') {
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ data: [{ id: 'ag/gemini-3.1-pro' }, { id: 'ag/gemini-3.7-flash-low' }] }))
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { model: string; tools?: unknown[]; messages?: Array<{ content?: unknown }> }
    requests.push(body)
    const content = body.tools?.length ? 'Jawaban headless berhasil.' : '{"difficulty":"simple","reason":"Pertanyaan sederhana."}'
    response.setHeader('Content-Type', 'text/event-stream')
    response.end(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as AddressInfo).port
  const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'src', 'index.ts'), 'exec', '--json', '--ephemeral', '--image', imagePath], {
    cwd: directory,
    env: { ...process.env, HOME: directory, NINEROUTER_URL: `http://127.0.0.1:${port}`, NINEROUTER_KEY: 'fake', BOO_MODEL: 'auto', BOO_EFFORT: '', BOO_TRACE: 'false' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let output = ''
  let errors = ''
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
  child.stderr.on('data', (chunk: Buffer) => { errors += chunk.toString() })
  const timer = setTimeout(() => child.kill(), 20_000)
  try {
    const closed = once(child, 'close')
    child.stdin.end('jawab singkat\n')
    const [exitCode] = await closed
    assert.equal(exitCode, 0, errors || output)
    const lines = output.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    assert.equal(lines[0].type, 'session.started')
    assert.equal(lines[0].session_id, null)
    assert.ok(lines.some((line) => line.type === 'model.selected'))
    assert.ok(lines.some((line) => line.type === 'assistant.delta'))
    const result = lines.at(-1)
    assert.equal(result?.type, 'result')
    assert.equal(result?.status, 'success')
    assert.equal(result?.answer, 'Jawaban headless berhasil.')
    assert.equal(requests.length, 2)
    assert.equal(requests[0].tools, undefined)
    assert.ok(requests[1].tools)
    const multimodal = requests[1].messages?.find((message) => Array.isArray(message.content))?.content as Array<{ type: string }> | undefined
    assert.deepEqual(multimodal?.map((part) => part.type), ['text', 'image_url'])
    assert.equal(output.includes('\u001b['), false)
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null) child.kill()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(directory, { recursive: true, force: true })
  }
})
