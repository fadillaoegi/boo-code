import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { listMcpServersTool, loadMcpServers, mcpCallTool, mcpCommand, mcpListToolsTool } from '../src/tools/mcp.ts'

const fakeServerPath = join(import.meta.dirname, 'fixtures', 'fake-mcp.mjs')

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'boo-mcp-repo-'))
  mkdirSync(join(root, '.git'))
  const workspace = join(root, 'packages', 'app')
  mkdirSync(join(workspace, '.boo'), { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'boo-mcp-home-'))
  mkdirSync(join(home, '.boo'), { recursive: true })
  return { root, workspace, home }
}

function configure(workspace: string): void {
  writeFileSync(join(workspace, '.boo', 'mcp.json'), JSON.stringify({ servers: {
    fake: { command: process.execPath, args: [fakeServerPath] },
  } }))
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
}

async function httpServer(handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((request, response) => { handler(request, response).catch((error) => { response.statusCode = 500; response.end(String(error)) }) })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server test tidak mendapat port')
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  }
}

function configureHttp(workspace: string, url: string, headers?: Record<string, string>): void {
  writeFileSync(join(workspace, '.boo', 'mcp.json'), JSON.stringify({ servers: { remote: { url, headers } } }))
}

test('konfigurasi terdekat menimpa global tanpa menjalankan server', async () => {
  const { root, workspace, home } = fixture()
  const marker = join(workspace, 'server-started')
  writeFileSync(join(home, '.boo', 'mcp.json'), JSON.stringify({ servers: {
    same: { command: 'global-command', args: ['global'] },
    disabled: { command: 'disabled-command', enabled: false },
  } }))
  mkdirSync(join(root, '.boo'))
  writeFileSync(join(root, '.boo', 'mcp.json'), JSON.stringify({ servers: {
    same: { command: 'project-command', args: ['argument with space'] },
    dormant: { command: 'touch', args: [marker] },
  } }))

  const servers = loadMcpServers(workspace, home)
  assert.deepEqual(servers.map((server) => [server.name, server.command, server.source]), [
    ['dormant', 'touch', 'project'], ['same', 'project-command', 'project'],
  ])
  assert.equal(mcpCommand(servers[1]), "'project-command' 'argument with space'")
  const listed = await listMcpServersTool.run({}, { workspace, home })
  assert.match(listed.content, /dormant \[project\/stdio\]/)
  assert.equal(existsSync(marker), false)
})

test('symlink konfigurasi yang keluar dari root diabaikan', () => {
  const { workspace } = fixture()
  const outside = mkdtempSync(join(tmpdir(), 'boo-mcp-outside-'))
  writeFileSync(join(outside, 'mcp.json'), JSON.stringify({ servers: { evil: { command: 'evil' } } }))
  symlinkSync(join(outside, 'mcp.json'), join(workspace, '.boo', 'mcp.json'))
  assert.deepEqual(loadMcpServers(workspace), [])
})

test('discovery dan call MCP stdio bekerja end-to-end serta memberi root workspace', async () => {
  const { workspace } = fixture()
  configure(workspace)
  const context = { workspace, sandbox: { mode: 'danger-full-access' as const } }

  const discovery = await mcpListToolsTool.run({ server: 'fake', timeout: 5 }, context)
  assert.equal(discovery.isError, undefined)
  assert.match(discovery.content, /"name": "echo"/)

  const call = await mcpCallTool.run({ server: 'fake', tool: 'echo', arguments: { message: 'halo' }, timeout: 5 }, context)
  assert.equal(call.isError, undefined)
  assert.match(call.content, /echo:halo/)
  assert.match(call.content, new RegExp(`root:${pathToFileURL(workspace).href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  assert.match(call.content, /"echoed": "halo"/)
})

test('isError dari MCP server dipertahankan dan call tidak dapat diizinkan permanen', async () => {
  const { workspace } = fixture()
  configure(workspace)
  const result = await mcpCallTool.run(
    { server: 'fake', tool: 'fail', timeout: 5 },
    { workspace, sandbox: { mode: 'danger-full-access' } },
  )
  assert.equal(result.isError, true)
  assert.match(result.content, /kegagalan dari server/)
  assert.equal(mcpCallTool.allowAlways, false)
})

test('konfigurasi HTTP memvalidasi URL/header dan tidak menampilkan nilai rahasia', async () => {
  const { workspace } = fixture()
  configureHttp(workspace, 'https://mcp.example.test/service', { Authorization: 'Bearer sangat-rahasia' })
  const servers = loadMcpServers(workspace)
  assert.equal(servers[0]?.transport, 'http')
  assert.equal(servers[0]?.url, 'https://mcp.example.test/service')
  const listed = await listMcpServersTool.run({}, { workspace })
  assert.match(listed.content, /remote \[project\/http\]/)
  assert.match(listed.content, /headers: Authorization/)
  assert.doesNotMatch(listed.content, /sangat-rahasia/)

  configureHttp(workspace, 'http://mcp.example.test/insecure')
  assert.deepEqual(loadMcpServers(workspace), [])
  configureHttp(workspace, 'https://mcp.example.test', { 'Mcp-Session-Id': 'override' })
  assert.deepEqual(loadMcpServers(workspace), [])
})

test('Streamable HTTP modern mendukung SSE, metadata, auth, dan x-mcp-header', async () => {
  const seen: Array<{ method: string; headers: Record<string, string | string[] | undefined>; params: unknown }> = []
  const server = await httpServer(async (request, response) => {
    const message = await body(request)
    const method = String(message.method)
    seen.push({ method, headers: request.headers, params: message.params })
    if (method === 'tools/list') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write(': keepalive\n\n')
      response.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [
        {
          name: 'weather',
          description: 'weather',
          inputSchema: { type: 'object', properties: { city: { type: 'string' }, region: { type: 'string', 'x-mcp-header': 'Region' } } },
        },
        {
          name: 'invalid_header_schema',
          inputSchema: { type: 'object', oneOf: [{ properties: { secret: { type: 'string', 'x-mcp-header': 'Secret' } } }] },
        },
      ] } })}\n\n`)
      return
    }
    assert.equal(method, 'tools/call')
    assert.equal(request.headers['mcp-name'], 'weather')
    assert.equal(request.headers['mcp-param-region'], 'id-jakarta')
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'cerah Bearer token-test' }] } }))
  })
  try {
    const { workspace } = fixture()
    configureHttp(workspace, server.url, { Authorization: 'Bearer token-test' })
    const context = { workspace, sandbox: { mode: 'workspace-write' as const, networkAccess: false } }
    const discovery = await mcpListToolsTool.run({ server: 'remote', timeout: 5 }, context)
    assert.equal(discovery.isError, undefined)
    assert.match(discovery.content, /"name": "weather"/)
    assert.doesNotMatch(discovery.content, /invalid_header_schema/)
    const call = await mcpCallTool.run({ server: 'remote', tool: 'weather', arguments: { city: 'Jakarta', region: 'id-jakarta' }, timeout: 5 }, context)
    assert.equal(call.isError, undefined)
    assert.equal(call.content, 'cerah [nilai MCP disembunyikan]')
    assert.doesNotMatch(call.content, /token-test/)
    const unknown = await mcpCallTool.run({ server: 'remote', tool: 'not_advertised', timeout: 5 }, context)
    assert.equal(unknown.isError, true)
    assert.match(unknown.content, /tidak ditemukan pada tools\/list/)
    assert.ok(seen.every((entry) => entry.headers.authorization === 'Bearer token-test'))
    assert.ok(seen.every((entry) => entry.headers['mcp-protocol-version'] === '2026-07-28'))
    assert.ok(seen.every((entry) => entry.headers['mcp-method'] === entry.method))
    assert.ok(seen.every((entry) => (entry.params as { _meta?: Record<string, unknown> })._meta?.['io.modelcontextprotocol/protocolVersion'] === '2026-07-28'))
  } finally {
    await server.close()
  }
})

test('Streamable HTTP fallback ke lifecycle 2025 dan menutup session', async () => {
  let initialized = false
  let deleted = false
  const session = 'boo-session-1'
  const server = await httpServer(async (request, response) => {
    if (request.method === 'DELETE') {
      assert.equal(request.headers['mcp-session-id'], session)
      deleted = true
      response.statusCode = 204
      response.end()
      return
    }
    const message = await body(request)
    const method = String(message.method)
    if (method === 'tools/list' && !request.headers['mcp-session-id']) {
      response.writeHead(400, { 'Content-Type': 'text/plain' })
      response.end('legacy server')
      return
    }
    if (method === 'initialize') {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': session })
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'legacy', version: '1' } } }))
      return
    }
    assert.equal(request.headers['mcp-session-id'], session)
    assert.equal(request.headers['mcp-protocol-version'], '2025-11-25')
    if (method === 'notifications/initialized') {
      initialized = true
      response.statusCode = 202
      response.end()
      return
    }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'legacy_echo', inputSchema: { type: 'object' } }] } }))
  })
  try {
    const { workspace } = fixture()
    configureHttp(workspace, server.url)
    const result = await mcpListToolsTool.run({ server: 'remote', timeout: 5 }, { workspace })
    assert.equal(result.isError, undefined)
    assert.match(result.content, /legacy_echo/)
    assert.equal(initialized, true)
    assert.equal(deleted, true)
  } finally {
    await server.close()
  }
})

test('MCP HTTP non-loopback mengikuti kebijakan network Boo', async () => {
  const { workspace } = fixture()
  configureHttp(workspace, 'https://mcp.example.test/service')
  const result = await mcpListToolsTool.run({ server: 'remote', timeout: 3 }, { workspace, sandbox: { mode: 'workspace-write', networkAccess: false } })
  assert.equal(result.isError, true)
  assert.match(result.content, /BOO_NETWORK_ACCESS/)
})
