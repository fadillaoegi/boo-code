import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { WebController } from '../src/server/controller.ts'
import { startWebServer } from '../src/server/http.ts'

test('server web hanya melayani API bertoken dari origin lokal', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'boo-web-'))
  const controller = new WebController({ workspace, home: workspace, config: {}, version: 'test' })
  const server = await startWebServer({
    controller,
    token: 'test-token',
    assets: { html: '<!doctype html><title>Boo</title>', js: 'export {}', css: '', logo: Buffer.from('png') },
  })

  try {
    const page = await fetch(server.url)
    assert.equal(page.status, 200)
    assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'none'/)

    const noToken = await fetch(`${server.url}api/sessions`)
    assert.equal(noToken.status, 401)

    const foreignOrigin = await fetch(`${server.url}api/submit`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token', Origin: 'https://attacker.invalid', 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'jangan jalan' }),
    })
    assert.equal(foreignOrigin.status, 403)

    const sessions = await fetch(`${server.url}api/sessions`, { headers: { Authorization: 'Bearer test-token' } })
    assert.equal(sessions.status, 200)
    assert.deepEqual(await sessions.json(), { sessions: [] })

    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('web-image')])
    const upload = await fetch(`${server.url}api/attachments`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token', 'Content-Type': 'image/png', 'X-Boo-Filename': encodeURIComponent('error layar.png') },
      body: png,
    })
    assert.equal(upload.status, 201)
    const uploaded = await upload.json() as { attachment: { name: string; ref: string } }
    assert.equal(uploaded.attachment.name, 'error layar.png')
    assert.match(uploaded.attachment.ref, /^[a-z0-9-]+\/[a-f0-9]{64}\.png$/)

    const fake = await fetch(`${server.url}api/attachments`, {
      method: 'POST', headers: { Authorization: 'Bearer test-token', 'Content-Type': 'image/png' }, body: '<svg/>',
    })
    assert.equal(fake.status, 400)
  } finally {
    controller.close()
    await server.close()
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('penyedia model dapat diatur dari halaman tanpa kuncinya pernah dikirim balik', async () => {
  const { createServer } = await import('node:http')
  const workspace = mkdtempSync(join(tmpdir(), 'boo-web-'))
  const configPath = join(workspace, 'boo.env')

  // 9Router tiruan yang menjawab daftar model.
  const upstream = createServer((request, response) => {
    response.writeHead(request.headers.authorization === 'Bearer kunci-benar' ? 200 : 401, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(request.headers.authorization === 'Bearer kunci-benar'
      ? { data: [{ id: 'ag/claude-sonnet-4-6' }, { id: 'cx/gpt-5.6-sol' }] }
      : { error: { message: 'kunci ditolak' } }))
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const upstreamUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`

  const controller = new WebController({ workspace, home: workspace, config: {}, version: 'test', configPath })
  const server = await startWebServer({
    controller,
    token: 'test-token',
    assets: { html: '<!doctype html>', js: 'export {}', css: '', logo: Buffer.from('png') },
  })
  const call = (path: string, body?: unknown) => fetch(`${server.url}api/${path}`, {
    ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
  })

  try {
    const before = await (await call('providers')).json() as { providers: { id: string; configured: boolean }[] }
    assert.deepEqual(before.providers.filter((provider) => provider.configured), [])

    const rejected = await call('providers', { id: 'ninerouter', baseUrl: upstreamUrl, apiKey: 'kunci-salah' })
    assert.equal(rejected.status, 502, 'kunci yang ditolak tidak boleh tersimpan')
    assert.ok(!existsSync(configPath), 'berkas setelan belum ditulis')

    const saved = await call('providers', { id: 'ninerouter', baseUrl: upstreamUrl, apiKey: 'kunci-benar' })
    assert.equal(saved.status, 200)
    const payload = await saved.text()
    assert.match(payload, /"models":2/)
    assert.doesNotMatch(payload, /kunci-benar/, 'kunci tidak pernah dikirim balik ke halaman')

    const stored = readFileSync(configPath, 'utf8')
    assert.match(stored, /NINEROUTER_KEY=kunci-benar/)
    assert.equal(statSync(configPath).mode & 0o777, 0o600)

    const after = await (await call('providers')).json() as { providers: { id: string; configured: boolean; hasKey: boolean; primary: boolean }[] }
    const router = after.providers.find((provider) => provider.id === 'ninerouter')
    assert.deepEqual({ configured: router?.configured, hasKey: router?.hasKey, primary: router?.primary }, { configured: true, hasKey: true, primary: true })
    assert.deepEqual((await (await call('models')).json() as { families: { key: string }[] }).families.map((family) => family.key).sort(), ['ag/claude-sonnet-4-6', 'cx/gpt-5.6-sol'])

    const removed = await call('providers', { id: 'ninerouter', remove: true })
    assert.equal(removed.status, 200)
    assert.deepEqual(((await (await call('providers')).json() as { providers: { configured: boolean }[] }).providers).filter((provider) => provider.configured), [])
  } finally {
    await server.close()
    upstream.closeAllConnections()
    upstream.close()
    rmSync(workspace, { recursive: true, force: true })
  }
})
