import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
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
