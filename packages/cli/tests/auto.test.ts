import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

test('CLI /model menawarkan Auto dan bisa kembali ke model manual', { timeout: 30_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'boo-cli-auto-'))
  const requests: { model: string; reasoning_effort?: string; tools?: unknown[] }[] = []
  const server = createServer(async (request, response) => {
    if (request.url === '/v1/models') {
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ data: ['ag/gemini-3.1-pro', 'ag/gemini-3.7-flash-low', 'cx/gpt-5.6-sol'].map((id) => ({ id })) }))
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const body = JSON.parse(Buffer.concat(chunks).toString()) as typeof requests[number]
    requests.push(body)
    const content = body.tools?.length ? 'Selesai.' : '{"difficulty":"complex","reason":"Refactor lintas modul."}'
    response.setHeader('Content-Type', 'text/event-stream')
    response.end(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as AddressInfo).port
  const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'src', 'index.ts')], {
    cwd: directory,
    env: { ...process.env, HOME: directory, NINEROUTER_URL: `http://127.0.0.1:${port}`, NINEROUTER_KEY: 'fake', BOO_MODEL: '', BOO_EFFORT: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString() })
  const timer = setTimeout(() => child.kill(), 20_000)
  try {
    const closed = once(child, 'close')
    child.stdin.end('/model\n1\nRefactor distributed API\n/model ag/gemini-3.1-pro\nubah judul\n/keluar\n')
    const [exitCode] = await closed
    assert.equal(exitCode, 0, output)
    assert.match(output, /Auto · sesuai kesulitan tugas/)
    assert.match(output, /Auto · menunggu tugas/)
    assert.ok(output.indexOf('Auto · menunggu tugas') < output.indexOf('Auto · sesuai kesulitan tugas'), 'sesi harus sudah Auto sebelum /model dibuka')
    assert.match(output, /GPT-5\.6 Sol/)
    assert.equal(requests.length, 3, 'satu penilai, satu task Auto, satu task manual')
    assert.equal(requests[0].model, 'ag/gemini-3.7-flash-low')
    assert.equal(requests[0].tools, undefined)
    assert.equal(requests[1].model, 'cx/gpt-5.6-sol')
    assert.equal(requests[1].reasoning_effort, 'high')
    assert.equal(requests[2].model, 'ag/gemini-3.1-pro')
    assert.equal(requests[2].reasoning_effort, undefined)
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null) child.kill()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(directory, { recursive: true, force: true })
  }
})
