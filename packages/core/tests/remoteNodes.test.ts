import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { callRemoteNode, generateNodeToken, loadRemoteNodes, pairRemoteNode, removeRemoteNode, safeRemoteNodeUrl } from '../src/remote/nodes.ts'

test('remote node hanya menerima HTTPS atau HTTP loopback dan menyimpan token privat', () => {
  const home = mkdtempSync(join(tmpdir(), 'boo-node-'))
  assert.equal(safeRemoteNodeUrl('http://192.168.1.2:4040'), null)
  assert.equal(safeRemoteNodeUrl('http://127.0.0.1:4040/'), 'http://127.0.0.1:4040')
  assert.equal(safeRemoteNodeUrl('https://laptop.example.test/'), 'https://laptop.example.test')
  const token = generateNodeToken()
  pairRemoteNode({ id: 'laptop', label: 'Laptop kerja', url: 'https://laptop.example.test', token }, home)
  assert.equal(loadRemoteNodes(home).nodes[0].token, token)
  assert.equal(statSync(join(home, '.boo', 'nodes.json')).mode & 0o777, 0o600)
  assert.equal(removeRemoteNode('laptop', home), true)
})

test('remote node menolak credential URL, query, token pendek, dan id traversal', () => {
  const home = mkdtempSync(join(tmpdir(), 'boo-node-'))
  assert.equal(safeRemoteNodeUrl('https://user:pass@example.test'), null)
  assert.equal(safeRemoteNodeUrl('https://example.test?a=secret'), null)
  assert.throws(() => pairRemoteNode({ id: '../x', label: 'x', url: 'https://example.test', token: 'pendek' }, home), /tidak sah/)
})

test('remote node client mengautentikasi request dan membaca respons protocol', async () => {
  const home = mkdtempSync(join(tmpdir(), 'boo-node-'))
  const token = generateNodeToken()
  let authorization = ''
  const server = createServer(async (request, response) => {
    authorization = request.headers.authorization ?? ''
    for await (const chunk of request) void chunk
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ ok: true, message: 'ready', app: 'Editor' }))
  })
  await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
  try {
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    pairRemoteNode({ id: 'local', label: 'Local', url: `http://127.0.0.1:${address.port}`, token }, home)
    const result = await callRemoteNode('local', { action: 'status' }, { home })
    assert.equal(result.app, 'Editor')
    assert.equal(authorization, `Bearer ${token}`)
  } finally { server.close() }
})
