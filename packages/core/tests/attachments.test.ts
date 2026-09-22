import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { imageDataUrl, storeImageData, storeImageFile } from '../src/agent/attachments.ts'
import { Agent } from '../src/agent/loop.ts'
import type { Message } from '../src/domain/message.ts'
import { buildTranscript } from '../src/presentation/transcript.ts'
import { NineRouterProvider } from '../src/provider/nineRouter.ts'
import { createDefaultRegistry } from '../src/tools/index.ts'

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('boo-image')])

test('attachment disimpan privat berbasis hash dan path sumber tidak masuk referensi', () => {
  const home = mkdtempSync(join(tmpdir(), 'boo-image-home-'))
  const source = join(mkdtempSync(join(tmpdir(), 'boo-image-source-')), 'Screenshot Rahasia.png')
  writeFileSync(source, PNG)
  const image = storeImageFile(source, { sessionId: 'session-12345678', home })
  assert.equal(image.mediaType, 'image/png')
  assert.equal(image.name, 'Screenshot Rahasia.png')
  assert.doesNotMatch(image.ref, /Screenshot|source/)
  const stored = join(home, '.boo', 'attachments', image.ref)
  assert.deepEqual(readFileSync(stored), PNG)
  assert.equal(statSync(stored).mode & 0o777, 0o600)
  assert.match(imageDataUrl(image, home), /^data:image\/png;base64,/)

  const changed = { ...image, bytes: image.bytes + 1 }
  assert.throws(() => imageDataUrl(changed, home), /berubah atau rusak/)
  const tampered = Buffer.from(PNG)
  tampered[tampered.length - 1] ^= 1
  writeFileSync(stored, tampered)
  assert.throws(() => imageDataUrl(image, home), /berubah atau rusak/)
})

test('format palsu, content-type salah, dan berkas sensitif ditolak', () => {
  const home = mkdtempSync(join(tmpdir(), 'boo-image-invalid-'))
  assert.throws(() => storeImageData(Buffer.from('<svg/>'), { sessionId: 'session-12345678', home, name: 'x.svg' }), /Format gambar/)
  assert.throws(() => storeImageData(PNG, { sessionId: 'session-12345678', home, name: 'x.jpg', declaredMediaType: 'image/jpeg' }), /tidak cocok/)
  const secret = join(home, '.env')
  writeFileSync(secret, PNG)
  chmodSync(secret, 0o600)
  assert.throws(() => storeImageFile(secret, { sessionId: 'session-12345678', home }), /sensitif/)
})

test('provider mengirim image_url data URI tanpa ref lokal dan transcript hanya menampilkan nama', async () => {
  const home = mkdtempSync(join(tmpdir(), 'boo-image-provider-'))
  const workspace = mkdtempSync(join(tmpdir(), 'boo-image-workspace-'))
  const image = storeImageData(PNG, { sessionId: 'session-12345678', home, name: 'error.png' })
  let body: { messages?: Array<{ content?: unknown; images?: unknown }> } = {}
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    body = JSON.parse(Buffer.concat(chunks).toString()) as typeof body
    response.setHeader('Content-Type', 'text/event-stream')
    response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Gambar dianalisis.' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as AddressInfo).port
  try {
    const provider = new NineRouterProvider({ baseUrl: `http://127.0.0.1:${port}`, apiKey: 'fake', model: 'vision', home })
    const agent = new Agent({ provider, registry: createDefaultRegistry(), workspace, askPermission: async () => false, verifyCompletion: false })
    for await (const event of agent.send('Apa error ini?', { images: [image] })) void event
    const user = body.messages?.find((message) => Array.isArray(message.content))
    assert.ok(Array.isArray(user?.content))
    const parts = user.content as Array<{ type: string; text?: string; image_url?: { url: string } }>
    assert.deepEqual(parts.map((part) => part.type), ['text', 'image_url'])
    assert.equal(parts[0].text, 'Apa error ini?')
    assert.match(parts[1].image_url?.url ?? '', /^data:image\/png;base64,/)
    assert.equal(user?.images, undefined)
    assert.doesNotMatch(JSON.stringify(body), /session-12345678|error\.png/)

    const restored = buildTranscript(agent.history as Message[]).flat().find((item) => item.kind === 'user')
    assert.deepEqual(restored?.kind === 'user' ? restored.attachments : undefined, ['error.png'])
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
