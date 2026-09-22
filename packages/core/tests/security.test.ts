import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { OUTBOUND_REDACTION_MARK, knownOutboundSecrets, redactOutboundMessages, redactSensitiveText } from '../src/security/redaction.ts'
import type { Message } from '../src/domain/message.ts'
import { NineRouterProvider } from '../src/provider/nineRouter.ts'

test('secret guard meredaksi format credential berkeyakinan tinggi tetapi mempertahankan kode biasa', () => {
  const github = `ghp_${'a'.repeat(40)}`
  const jwt = `eyJ${'a'.repeat(12)}.eyJ${'b'.repeat(12)}.${'c'.repeat(12)}`
  const pem = '-----BEGIN PRIVATE KEY-----\nvery-private-material\n-----END PRIVATE KEY-----'
  const input = [
    'NINEROUTER_KEY=router-key-123456',
    'Authorization: Bearer bearer-value-123456',
    'Cookie: session=private-cookie',
    'DATABASE_URL=https://admin:password123@example.com/data',
    '{"password":"hunter2-value"}',
    `token GitHub ${github}`,
    `jwt ${jwt}`,
    pem,
    'const token = getToken()',
  ].join('\n')
  const result = redactSensitiveText(input, { environment: {} })

  for (const secret of ['router-key-123456', 'bearer-value-123456', 'private-cookie', 'admin:password123', 'hunter2-value', github, jwt, 'very-private-material']) {
    assert.doesNotMatch(result.text, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
  assert.match(result.text, new RegExp(OUTBOUND_REDACTION_MARK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(result.text, /const token = getToken\(\)/)
  assert.ok(result.redactions >= 8)
})

test('nilai rahasia yang diketahui ikut dilindungi dalam bentuk URL-encoded dan base64', () => {
  const secret = 'p@ss/word+with-symbols'
  const encoded = encodeURIComponent(secret)
  const base64 = Buffer.from(secret).toString('base64')
  const variants = knownOutboundSecrets({ secrets: [secret], environment: { SERVICE_TOKEN: 'environment-token-123456' } })
  assert.ok(variants.includes(secret))
  assert.ok(variants.includes(encoded))
  assert.ok(variants.includes(base64))

  const result = redactSensitiveText(`${secret}\n${encoded}\n${base64}\nenvironment-token-123456`, {
    secrets: [secret],
    environment: { SERVICE_TOKEN: 'environment-token-123456' },
  })
  for (const value of [secret, encoded, base64, 'environment-token-123456']) assert.doesNotMatch(result.text, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.equal(result.redactions, 4)
})

test('seluruh bidang teks pesan disalin dan disanitasi tanpa mengubah history lokal', () => {
  const secret = 'exact-secret-123456'
  const messages: Message[] = [
    { role: 'system', content: `aturan ${secret}` },
    { role: 'user', content: `tolong pakai ${secret}` },
    {
      role: 'assistant',
      content: null,
      reasoning_content: `memikirkan ${secret}`,
      tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: `echo ${secret}` }) } }],
    },
    { role: 'tool', tool_call_id: 'call-1', content: `hasil ${secret}` },
  ]
  const result = redactOutboundMessages(messages, { secrets: [secret], environment: {} })
  assert.equal(result.redactions, 5)
  assert.doesNotMatch(JSON.stringify(result.messages), new RegExp(secret))
  assert.match(JSON.stringify(result.messages), /RAHASIA DISEMBUNYIKAN OLEH BOO/)
  assert.match(JSON.stringify(messages), new RegExp(secret), 'riwayat lokal tidak boleh dimutasi')
})

test('provider hanya mengirim credential pada header autentikasi, bukan isi pesan', async () => {
  const apiKey = 'provider-key-never-in-body'
  let authorization = ''
  let body = ''
  const server = createServer(async (request, response) => {
    authorization = String(request.headers.authorization ?? '')
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    body = Buffer.concat(chunks).toString('utf8')
    response.setHeader('content-type', 'text/event-stream')
    response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'aman' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as AddressInfo).port
  try {
    const provider = new NineRouterProvider({ baseUrl: `http://127.0.0.1:${port}`, apiKey, model: 'test-model' })
    const stream = provider.stream([{ role: 'user', content: `kunci saya ${apiKey}` }], [])
    for await (const event of stream) void event
    assert.equal(authorization, `Bearer ${apiKey}`)
    assert.doesNotMatch(body, new RegExp(apiKey))
    assert.match(body, /RAHASIA DISEMBUNYIKAN OLEH BOO/)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
