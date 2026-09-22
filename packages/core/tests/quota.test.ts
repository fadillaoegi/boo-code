import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { DashboardError, extractQuotaEntries, fetchNineRouterQuota, forgetDashboardSession, loginToDashboard } from '../src/provider/nineRouterDashboard.ts'
import type { ProviderProfile } from '../src/provider/profiles.ts'
import { fetchOpenRouterCredits, parseResetDuration, QuotaTracker, readRateLimitHeaders } from '../src/provider/quota.ts'
import { gatherQuota } from '../src/provider/quotaReport.ts'

async function serve(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  return { url: `http://127.0.0.1:${port}`, close: () => { server.closeAllConnections(); server.close() } }
}

function profile(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return { id: 'ninerouter', label: '9Router', baseUrl: 'http://127.0.0.1:1', apiKey: 'kunci', wire: 'openai', ...overrides }
}

/* ------------------------------------------------------------------ header */

test('sisa jatah dibaca dari header OpenAI maupun Anthropic', () => {
  const openai = readRateLimitHeaders(new Headers({
    'x-ratelimit-remaining-requests': '58',
    'x-ratelimit-limit-requests': '60',
    'x-ratelimit-remaining-tokens': '12000',
    'x-ratelimit-limit-tokens': '150000',
    'x-ratelimit-reset-tokens': '6m0s',
  }))
  // Token tersisa 8% sedangkan permintaan 96%; yang paling menekan yang ditampilkan.
  assert.equal(openai?.unit, 'tokens')
  assert.equal(openai?.remaining, 12_000)
  assert.ok(openai?.resetAt && openai.resetAt - Date.now() > 5 * 60_000)

  const anthropic = readRateLimitHeaders(new Headers({
    'anthropic-ratelimit-requests-remaining': '3',
    'anthropic-ratelimit-requests-limit': '50',
  }))
  assert.equal(anthropic?.unit, 'requests')
  assert.equal(anthropic?.remaining, 3)
  assert.equal(readRateLimitHeaders(new Headers({ 'content-type': 'application/json' })), null)
})

test('format waktu pulih: detik polos, gabungan, dan tanggal', () => {
  assert.equal(parseResetDuration('30'), 30_000)
  assert.equal(parseResetDuration('2m30s'), 150_000)
  assert.equal(parseResetDuration('1h'), 3_600_000)
  const iso = parseResetDuration(new Date(Date.now() + 60_000).toISOString())
  assert.ok(iso !== undefined && iso > 50_000 && iso <= 60_000)
  assert.equal(parseResetDuration(null), undefined)
})

/* ----------------------------------------------------------------- pelacak */

test('pelacak mencatat permintaan, token, dan cooldown', () => {
  const tracker = new QuotaTracker()
  tracker.recordRequest('ninerouter', 'ag/gemini', new Headers({ 'x-ratelimit-remaining-requests': '9', 'x-ratelimit-limit-requests': '10' }))
  tracker.recordTokens('ninerouter', 'ag/gemini', 'a'.repeat(400), 'b'.repeat(80))
  assert.deepEqual(tracker.entries().map((entry) => [entry.label, entry.state, entry.remaining, entry.source]), [['ag/gemini', 'ok', 9, 'headers']])
  const [usage] = tracker.usageEntries()
  assert.equal(usage.requests, 1)
  assert.equal(usage.inputTokens, 100)
  assert.equal(usage.outputTokens, 20)

  tracker.recordFailure('ninerouter', 'cx/gpt', 'Resource exhausted (reset after 20s)', 20_000)
  const cooling = tracker.entries().find((entry) => entry.label === 'cx/gpt')
  assert.equal(cooling?.state, 'cooldown')
  assert.match(String(cooling?.detail), /reset after 20s/)
  assert.ok(cooling?.resetAt && cooling.resetAt > Date.now())

  // Permintaan berikutnya yang berhasil menghapus status cooldown.
  tracker.recordRequest('ninerouter', 'cx/gpt')
  assert.equal(tracker.entries().find((entry) => entry.label === 'cx/gpt')?.state, 'unknown')
})

/* --------------------------------------------------------------- dashboard */

test('kuota dashboard diambil dari bentuk apa pun, tanpa menyentuh kredensial', () => {
  const payload = {
    providers: [
      { name: 'Antigravity utama', accessToken: 'ya29.rahasia-sekali', quotaLimit: 1000, quotaUsed: 250, resetsAt: '2026-09-23T10:00:00Z' },
      { label: 'Codex kantor', remaining: 0, limit: 500, disabled: true },
      { id: 'node-3', refreshToken: 'jangan-dibaca', nested: { accountName: 'Kiro', requestsRemaining: 42 } },
    ],
  }
  const entries = extractQuotaEntries(payload, 'ninerouter')
  assert.deepEqual(entries.map((entry) => [entry.label, entry.remaining, entry.limit, entry.state]), [
    ['Antigravity utama', 750, 1000, 'ok'],
    ['Codex kantor', 0, 500, 'exhausted'],
    ['Kiro', 42, undefined, 'ok'],
  ])
  const serialized = JSON.stringify(entries)
  assert.doesNotMatch(serialized, /ya29|rahasia|jangan-dibaca/, 'token akun tidak pernah ikut')
})

test('password salah dilaporkan beserta sisa percobaan, tanpa dicoba ulang', async () => {
  let attempts = 0
  const server = await serve((_request, response) => {
    attempts += 1
    response.writeHead(401, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ error: 'Invalid password.', remainingBeforeLock: 3 }))
  })
  try {
    await assert.rejects(
      () => loginToDashboard(server.url, 'salah'),
      (error: unknown) => error instanceof DashboardError && error.attemptsLeft === 3 && /Invalid password/.test(error.message),
    )
    assert.equal(attempts, 1, 'hanya satu percobaan yang dikirim')
  } finally {
    server.close()
  }
})

test('sesi dipakai ulang, dan login ulang hanya saat sesi kedaluwarsa', async () => {
  let logins = 0
  let sessionValid = false
  const server = await serve(async (request, response) => {
    if (request.url === '/api/auth/login') {
      logins += 1
      sessionValid = true
      response.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'boo_session=abc; Path=/; HttpOnly' })
      response.end('{}')
      return
    }
    if (!sessionValid || request.headers.cookie !== 'boo_session=abc') {
      response.writeHead(401, { 'Content-Type': 'application/json' })
      response.end('{"error":"Unauthorized"}')
      return
    }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(request.url?.includes('provider-nodes')
      ? []
      : [{ name: 'Gemini pribadi', remaining: 120, limit: 300 }]))
  })
  try {
    forgetDashboardSession(server.url)
    const first = await fetchNineRouterQuota({ baseUrl: server.url, password: 'benar' })
    assert.deepEqual(first.map((entry) => [entry.label, entry.remaining, entry.source]), [['Gemini pribadi', 120, 'dashboard']])
    assert.equal(logins, 1)

    await fetchNineRouterQuota({ baseUrl: server.url, password: 'benar' })
    assert.equal(logins, 1, 'cookie yang masih berlaku dipakai ulang')

    sessionValid = false
    await fetchNineRouterQuota({ baseUrl: server.url, password: 'benar' })
    assert.equal(logins, 2, 'login ulang sekali saat sesi kedaluwarsa')
  } finally {
    forgetDashboardSession(server.url)
    server.close()
  }
})

/* ------------------------------------------------------------- penggabungan */

test('saldo OpenRouter terbaca, dan 9Router tanpa password dijelaskan', async () => {
  const openrouter = await serve((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ data: { usage: 2.5, limit: 10, limit_remaining: 7.5, is_free_tier: false } }))
  })
  try {
    const credits = await fetchOpenRouterCredits(profile({ id: 'openrouter', label: 'OpenRouter', baseUrl: `${openrouter.url}/api/v1` }))
    assert.equal(credits?.remaining, 7.5)
    assert.equal(credits?.unit, 'usd')
    assert.equal(credits?.state, 'ok')

    const report = await gatherQuota({
      profiles: [profile(), profile({ id: 'openrouter', label: 'OpenRouter', baseUrl: `${openrouter.url}/api/v1` })],
      config: {},
    })
    assert.ok(report.entries.some((entry) => entry.providerId === 'openrouter'))
    assert.ok(report.notes.some((note) => /password dashboard/i.test(note)), report.notes.join(' | '))
  } finally {
    openrouter.close()
  }
})
