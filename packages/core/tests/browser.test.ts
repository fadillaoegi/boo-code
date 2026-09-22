import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import type { Duplex } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import {
  browserCdpUrl,
  browserClickTool,
  browserDiagnosticsTool,
  browserNavigateTool,
  browserOpenTool,
  browserPressTool,
  browserSelectTool,
  browserSnapshotTool,
  browserStatus,
  browserTabsTool,
  browserTypeTool,
  clickBrowserElement,
  collectBrowserDiagnostics,
  listBrowserTabs,
  navigateBrowserTab,
  openBrowserTab,
  pressBrowserKey,
  selectBrowserOption,
  snapshotBrowserTab,
  typeBrowserText,
  validateBrowserUrl,
} from '../src/tools/browser.ts'
import { describeRequest } from '../src/presentation/approval.ts'

function serverFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value))
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload])
  if (payload.length <= 0xffff) {
    const header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(payload.length, 2)
    return Buffer.concat([header, payload])
  }
  const header = Buffer.alloc(10)
  header[0] = 0x81
  header[1] = 127
  header.writeBigUInt64BE(BigInt(payload.length), 2)
  return Buffer.concat([header, payload])
}

function receiveWebSocket(socket: Duplex, respond: (message: { id: number; method: string; params?: Record<string, unknown> }) => unknown): void {
  let buffered = Buffer.alloc(0)
  socket.on('data', (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk])
    for (;;) {
      if (buffered.length < 2) return
      const opcode = buffered[0] & 0x0f
      let length = buffered[1] & 0x7f
      let offset = 2
      if (length === 126) {
        if (buffered.length < 4) return
        length = buffered.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (buffered.length < 10) return
        length = Number(buffered.readBigUInt64BE(2))
        offset = 10
      }
      const masked = Boolean(buffered[1] & 0x80)
      const maskBytes = masked ? 4 : 0
      if (buffered.length < offset + maskBytes + length) return
      if (opcode === 8) { socket.end(); return }
      const mask = masked ? buffered.subarray(offset, offset + 4) : null
      offset += maskBytes
      const payload = Buffer.from(buffered.subarray(offset, offset + length))
      if (mask) for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4]
      buffered = buffered.subarray(offset + length)
      const message = JSON.parse(payload.toString('utf8')) as { id: number; method: string; params?: Record<string, unknown> }
      socket.write(serverFrame({ id: message.id, result: respond(message) }))
    }
  })
}

test('konfigurasi CDP browser hanya menerima endpoint loopback tanpa credential', async () => {
  const home = await mkdtemp(join(tmpdir(), 'boo-browser-config-'))
  await mkdir(join(home, '.boo'))
  await writeFile(join(home, '.boo', 'browser.json'), JSON.stringify({ cdpUrl: 'http://127.0.0.1:9333' }))
  assert.equal(browserCdpUrl(home, {}), 'http://127.0.0.1:9333/')
  for (const cdpUrl of ['http://example.com:9222', 'http://user:pass@localhost:9222', 'http://localhost:9222?token=x']) {
    await writeFile(join(home, '.boo', 'browser.json'), JSON.stringify({ cdpUrl }))
    assert.throws(() => browserCdpUrl(home, {}), /localhost\/127\.0\.0\.1|tanpa credential/)
  }
})

test('URL navigasi hanya HTTP(S) tanpa credential tertanam', () => {
  assert.equal(validateBrowserUrl('https://example.com/docs').href, 'https://example.com/docs')
  assert.equal(validateBrowserUrl('http://localhost:3000').href, 'http://localhost:3000/')
  for (const value of ['javascript:alert(1)', 'file:///tmp/a', 'data:text/plain,x', 'https://user:secret@example.com']) {
    assert.throws(() => validateBrowserUrl(value))
  }
})

test('status, daftar tab, dan membuka URL bekerja melalui endpoint CDP lokal', async () => {
  let opened = ''
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json')
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    if (request.url?.startsWith('/json/new') && request.method === 'PUT') {
      opened = request.url
      response.end(JSON.stringify({ id: 'tab-new', type: 'page', title: 'Baru', url: 'https://example.com/docs?token=secret#private', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/tab-new` }))
      return
    }
    response.end(JSON.stringify([
      { id: 'tab-one', type: 'page', title: 'Dokumentasi', url: 'https://example.com/docs?token=secret#bagian', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/tab-one` },
      { id: 'worker', type: 'service_worker', title: 'worker', url: 'https://example.com/sw.js' },
    ]))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const home = await mkdtemp(join(tmpdir(), 'boo-browser-server-'))
    await mkdir(join(home, '.boo'))
    await writeFile(join(home, '.boo', 'browser.json'), JSON.stringify({ cdpUrl: `http://127.0.0.1:${address.port}` }))
    assert.match(await browserStatus(home), /1 tab halaman/)
    const tabs = await listBrowserTabs(home)
    assert.equal(tabs.length, 1)
    assert.equal(tabs[0].id, 'tab-one')
    assert.doesNotMatch(tabs[0].url, /secret|bagian/)
    const created = await openBrowserTab('https://example.com/docs?a=1#target', home)
    assert.equal(created.id, 'tab-new')
    assert.ok(opened.startsWith('/json/new?https://example.com/docs'))
    assert.doesNotMatch(created.url, /secret|private/)
  } finally {
    server.close()
    await once(server, 'close')
  }
})

test('snapshot dan seluruh aksi tab memakai WebSocket CDP pada tab yang dipilih', async () => {
  let clicks = 0
  const inserted: string[] = []
  const navigated: string[] = []
  const keyEvents: { type?: unknown; key?: unknown }[] = []
  let reloads = 0
  const server = createServer((_request, response) => {
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify([{ id: 'tab-live', type: 'page', title: 'Form', url: 'https://example.com/form', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/tab-live` }]))
  })
  server.on('upgrade', (request, socket) => {
    const rawKey = request.headers['sec-websocket-key']
    const key = Array.isArray(rawKey) ? rawKey[0] : rawKey
    assert.ok(key)
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    receiveWebSocket(socket, (message) => {
      if (message.method === 'Input.insertText') {
        inserted.push(String(message.params?.text ?? ''))
        return {}
      }
      if (message.method === 'Page.navigate') {
        navigated.push(String(message.params?.url ?? ''))
        return {}
      }
      if (message.method === 'Input.dispatchKeyEvent') {
        keyEvents.push({ type: message.params?.type, key: message.params?.key })
        return {}
      }
      if (message.method === 'Page.reload') {
        reloads += 1
        return {}
      }
      if (message.method === 'Network.enable') {
        setTimeout(() => {
          socket.write(serverFrame({ method: 'Runtime.consoleAPICalled', params: { type: 'warning', args: [{ value: 'Deprecated API at https://example.com/app?token=console-secret' }] } }))
          socket.write(serverFrame({ method: 'Network.requestWillBeSent', params: { requestId: 'request-1', request: { method: 'GET', url: 'https://api.example.com/data?api_key=network-secret' } } }))
          socket.write(serverFrame({ method: 'Network.responseReceived', params: { requestId: 'request-1', response: { status: 503, url: 'https://api.example.com/data?api_key=network-secret' } } }))
        }, 10)
        return {}
      }
      const expression = String(message.params?.expression ?? '')
      if (expression.includes("document.querySelectorAll('[data-boo-ref]')")) {
        return { result: { value: { title: 'Form Demo', url: 'https://example.com/form?session=secret', text: 'Cari dokumentasi', elements: [{ ref: 'e1', kind: 'text', label: 'Pencarian' }, { ref: 'e2', kind: 'button', label: 'Cari' }, { ref: 'e3', kind: 'select', label: 'Periode' }] } } }
      }
      if (expression.includes('element.click()')) {
        clicks += 1
        return { result: { value: { ok: true } } }
      }
      if (expression.includes('HTMLSelectElement')) return { result: { value: { ok: true, label: 'Bulanan' } } }
      if (expression.includes('element.focus()')) return { result: { value: { ok: true } } }
      return { result: { value: { title: 'Hasil', url: 'https://example.com/results?q=private' } } }
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const home = await mkdtemp(join(tmpdir(), 'boo-browser-ws-'))
    await mkdir(join(home, '.boo'))
    await writeFile(join(home, '.boo', 'browser.json'), JSON.stringify({ cdpUrl: `http://127.0.0.1:${address.port}` }))

    const snapshot = await snapshotBrowserTab('tab-live', home)
    assert.equal(snapshot.title, 'Form Demo')
    assert.deepEqual(snapshot.elements.map((element) => element.ref), ['e1', 'e2', 'e3'])
    assert.match(await navigateBrowserTab('tab-live', 'https://example.com/report?token=private', home), /dinavigasikan/)
    assert.deepEqual(navigated, ['https://example.com/report?token=private'])
    assert.match(await clickBrowserElement('tab-live', 'e2', home), /Elemen e2 diklik/)
    assert.equal(clicks, 1)
    assert.match(await typeBrowserText('tab-live', 'e1', 'Node.js API', true, home), /Form belum dikirim/)
    assert.deepEqual(inserted, ['Node.js API'])
    assert.match(await selectBrowserOption('tab-live', 'e3', 'Bulanan', home), /Dropdown e3 dipilih: Bulanan/)
    assert.match(await pressBrowserKey('tab-live', 'e2', 'Enter', home), /Tombol Enter ditekan/)
    assert.deepEqual(keyEvents, [{ type: 'keyDown', key: 'Enter' }, { type: 'keyUp', key: 'Enter' }])
    const diagnostics = await collectBrowserDiagnostics('tab-live', { reload: true, waitMs: 250 }, home)
    assert.equal(reloads, 1)
    assert.deepEqual(diagnostics.issues.map((issue) => issue.kind), ['console', 'http'])
    assert.ok(diagnostics.issues.every((issue) => !`${issue.message} ${issue.url ?? ''}`.includes('secret')))
    const diagnosticToolResult = await browserDiagnosticsTool.run({ tab_id: 'tab-live', wait_ms: 250 }, { workspace: home, home })
    assert.equal(diagnosticToolResult.isError, undefined)
    assert.match(diagnosticToolResult.content, /DIAGNOSTIK BROWSER EKSTERNAL/)
    assert.match(diagnosticToolResult.content, /HTTP 503/)
    assert.doesNotMatch(diagnosticToolResult.content, /console-secret|network-secret/)
  } finally {
    server.close()
    await once(server, 'close')
  }
})

test('seluruh pembacaan dan aksi browser meminta persetujuan baru', () => {
  for (const tool of [browserTabsTool, browserOpenTool, browserNavigateTool, browserSnapshotTool, browserDiagnosticsTool, browserClickTool, browserTypeTool, browserSelectTool, browserPressTool]) {
    assert.equal(tool.risk, 'confirm', tool.name)
    assert.equal(tool.allowAlways, false, tool.name)
  }
  const click = describeRequest('browser_click', { tab_id: 'tab-one', ref: 'e4', description: 'Tombol Bayar' }, false)
  assert.equal(click.title, 'Klik di browser')
  assert.match(click.question, /Tombol Bayar.*e4.*tab-one/)
  const type = describeRequest('browser_type', { tab_id: 'tab-one', ref: 'e2', description: 'Pencarian', text: 'dokumentasi API' }, false)
  assert.equal(type.title, 'Ketik di browser')
  assert.match(type.question, /dokumentasi API/)
  assert.match(type.allowAlways, /setiap input/)
  const navigate = describeRequest('browser_navigate', { tab_id: 'tab-one', url: 'https://example.com/report' }, false)
  assert.match(navigate.question, /tab-one.*https:\/\/example\.com\/report/s)
  const select = describeRequest('browser_select', { tab_id: 'tab-one', ref: 'e3', description: 'Periode', option: 'Bulanan' }, false)
  assert.match(select.question, /Bulanan.*Periode.*e3.*tab-one/)
  const press = describeRequest('browser_press', { tab_id: 'tab-one', ref: 'e2', description: 'Cari', key: 'Enter' }, false)
  assert.match(press.question, /Enter.*Cari.*e2.*tab-one/)
  const diagnostics = describeRequest('browser_diagnostics', { tab_id: 'tab-one', reload: true, wait_ms: 750 }, false)
  assert.match(diagnostics.question, /tab-one.*750 ms.*memuat ulang/)
  assert.match(diagnostics.question, /cookie.*tidak dibaca/)
})

test('argumen aksi invalid ditolak sebelum koneksi browser', async () => {
  const context = { workspace: process.cwd() }
  const open = await browserOpenTool.run({ url: 'javascript:alert(1)' }, context)
  const click = await browserClickTool.run({ tab_id: 'tab one', ref: 'e1', description: 'Tombol' }, context)
  const type = await browserTypeTool.run({ tab_id: 'tab-one', ref: 'e1', description: 'Kolom', text: '' }, context)
  const navigate = await browserNavigateTool.run({ tab_id: 'tab-one', url: 'javascript:alert(1)' }, context)
  const select = await browserSelectTool.run({ tab_id: 'tab-one', ref: 'e3', description: 'Periode', option: 'Baris\nbaru' }, context)
  const press = await browserPressTool.run({ tab_id: 'tab-one', ref: 'e2', description: 'Cari', key: 'A' }, context)
  const diagnostics = await browserDiagnosticsTool.run({ tab_id: 'tab-one', wait_ms: 1 }, context)
  assert.equal(open.isError, true)
  assert.match(open.content, /HTTP\(S\)/)
  assert.equal(click.isError, true)
  assert.match(click.content, /Tab ID/)
  assert.equal(type.isError, true)
  assert.match(type.content, /1–4000/)
  assert.equal(navigate.isError, true)
  assert.match(navigate.content, /HTTP\(S\)/)
  assert.equal(select.isError, true)
  assert.match(select.content, /satu baris/)
  assert.equal(press.isError, true)
  assert.match(press.content, /Tombol keyboard/)
  assert.equal(diagnostics.isError, true)
  assert.match(diagnostics.content, /250–10000/)
})
