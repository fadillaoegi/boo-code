import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer, type ServerResponse } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Agent, FAILED_REPLY_PREFIX, turnLimitReply, type AgentEvent, type AgentOptions } from '../src/agent/loop.ts'
import type { Message } from '../src/domain/message.ts'
import { httpError, NineRouterProvider, ProviderError } from '../src/provider/nineRouter.ts'
import { createDefaultRegistry } from '../src/tools/index.ts'

const workspace = mkdtempSync(join(tmpdir(), 'boo-ulang-'))

type Step = Error | Message | ((signal?: AbortSignal) => Promise<Message>)

/** Provider palsu: setiap panggilan menjalankan langkah berikutnya, terakhir diulang. */
function scripted(steps: Step[], seen: Message[][] = []) {
  let index = 0
  return {
    calls: () => index,
    provider: {
      model: 'palsu',
      stream(messages: Message[], _tools: unknown, signal?: AbortSignal) {
        seen.push(messages.map((message) => ({ ...message })))
        const step = steps[Math.min(index, steps.length - 1)]
        index += 1
        return (async function* run() {
          if (step instanceof Error) throw step
          const message = typeof step === 'function' ? await step(signal) : step
          if (message.content) yield { type: 'text' as const, delta: message.content }
          return { finishReason: message.tool_calls ? 'tool_calls' : 'stop', message }
        })()
      },
    } as unknown as NineRouterProvider,
  }
}

function agentWith(provider: NineRouterProvider, options: Partial<AgentOptions> = {}) {
  return new Agent({
    provider,
    registry: createDefaultRegistry(),
    workspace,
    askPermission: async () => true,
    retryDelaysMs: [10, 10, 10],
    ...options,
  })
}

async function collect(events: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const list: AgentEvent[] = []
  for await (const event of events) list.push(event)
  return list
}

const limited = () => new ProviderError('[codex/gpt] [429]: rate limit', { status: 429, retryable: true })

test('klasifikasi error 9Router: status menentukan, bukan tanda reset', () => {
  assert.equal(httpError('{"error":{"message":"too many"}}', 429).retryable, true)
  assert.equal(httpError('{"error":{"message":"bad gateway"}}', 502).retryable, true)

  const invalid = httpError(`{"error":{"message":"[codex/gpt-5.4-mini] [400]: model not supported (reset after 20s)"}}`, 400)
  assert.equal(invalid.retryable, false, 'permintaan yang salah tetap salah bila diulang')

  const wrapped = httpError(`{"error":{"message":"[antigravity/gemini] [429]: quota (reset after 20s)"}}`, 400)
  assert.equal(wrapped.status, 429, 'status provider di dalam pesan yang dipakai')
  assert.equal(wrapped.retryable, true)
  assert.equal(wrapped.retryAfterMs, 20_000)

  assert.equal(httpError(`{"error":{"message":"[x] [429]: quota (reset after 3600s)"}}`, 429).retryable, false, 'jeda sejam tidak ditunggu')
  assert.equal(httpError('bukan json', 401).retryable, false)
})

test('gagal sementara diulang lalu berhasil', async () => {
  const { provider, calls } = scripted([limited(), limited(), { role: 'assistant', content: 'akhirnya' }])
  const agent = agentWith(provider)
  const events = await collect(agent.send('halo'))
  const retries = events.filter((event) => event.type === 'retry')
  assert.equal(retries.length, 2)
  assert.equal(calls(), 3)
  assert.ok(!events.some((event) => event.type === 'error'))
  assert.equal(agent.history.at(-1)?.content, 'akhirnya')
})

test('jeda dari 9Router dihormati', async () => {
  const error = new ProviderError('quota (reset after 1s)', { status: 429, retryable: true, retryAfterMs: 200 })
  const { provider } = scripted([error, { role: 'assistant', content: 'ok' }])
  const started = Date.now()
  const events = await collect(agentWith(provider).send('halo'))
  const retry = events.find((event) => event.type === 'retry')
  assert.equal(retry?.type === 'retry' && retry.delayMs, 700)
  assert.ok(Date.now() - started >= 650)
})

test('error permanen tidak diulang, dan riwayat tetap sah untuk permintaan berikutnya', async () => {
  const seen: Message[][] = []
  const { provider, calls } = scripted([
    new ProviderError('[codex/x] [400]: model not supported', { status: 400, retryable: false }),
    { role: 'assistant', content: 'baik' },
  ], seen)
  const agent = agentWith(provider)
  const events = await collect(agent.send('pertama'))
  assert.equal(calls(), 1)
  assert.equal(events.at(-1)?.type, 'error')
  assert.equal(agent.history.at(-1)?.content, `${FAILED_REPLY_PREFIX}[codex/x] [400]: model not supported)`)

  await collect(agent.send('kedua'))
  assert.deepEqual(seen.at(-1)!.filter((m) => m.role !== 'system').map((m) => m.role), ['user', 'assistant', 'user'])
})

test('pengulangan yang habis dilaporkan sebagai error', async () => {
  const { provider, calls } = scripted([limited()])
  const events = await collect(agentWith(provider).send('halo'))
  assert.equal(calls(), 4, 'satu percobaan ditambah tiga ulangan')
  assert.equal(events.at(-1)?.type, 'error')
})

test('Esc selama menunggu pengulangan langsung berhenti', async () => {
  const { provider } = scripted([limited()])
  const controller = new AbortController()
  const agent = agentWith(provider, { retryDelaysMs: [10_000] })
  setTimeout(() => controller.abort(), 100)
  const started = Date.now()
  const events = await collect(agent.send('halo', { signal: controller.signal }))
  assert.ok(Date.now() - started < 1_000)
  assert.equal(events.at(-1)?.type, 'cancelled')
})

test('batas langkah: pengguna ditanya, boleh lanjut, lalu berhenti dengan riwayat sah', async () => {
  let counter = 0
  const { provider } = scripted([async () => {
    counter += 1
    return {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: `c${counter}`, type: 'function', function: { name: 'list_dir', arguments: '{"path":"."}' } }],
    }
  }])
  const asked: number[] = []
  const agent = agentWith(provider, {
    maxTurns: 2,
    onTurnLimit: async (turns) => {
      asked.push(turns)
      return turns < 4
    },
  })
  const events = await collect(agent.send('telusuri terus'))
  assert.deepEqual(asked, [2, 4])
  assert.equal(events.filter((event) => event.type === 'turn-start').length, 4)
  assert.deepEqual(events.at(-1), { type: 'turn-limit', turns: 4 })
  assert.equal(agent.history.at(-1)?.content, turnLimitReply(4))
  const unanswered = agent.history.flatMap((m) => m.tool_calls ?? []).filter((call) => !agent.history.some((m) => m.tool_call_id === call.id))
  assert.deepEqual(unanswered, [])
})

/* -------------------------------------------------------- HTTP sungguhan */

function sse(response: ServerResponse, text: string) {
  response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`)
}

async function serve(handler: (count: number, response: ServerResponse) => void) {
  let count = 0
  const server = createServer((_request, response) => {
    count += 1
    handler(count, response)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => { server.closeAllConnections(); server.close() },
  }
}

test('HTTP: 503 lalu berhasil, lewat provider sungguhan', async () => {
  const server = await serve((count, response) => {
    if (count === 1) {
      response.writeHead(503, { 'Content-Type': 'application/json' })
      response.end('{"error":{"message":"upstream sibuk"}}')
      return
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    sse(response, 'pulih')
    response.end('data: [DONE]\n\n')
  })
  try {
    const provider = new NineRouterProvider({ baseUrl: server.url, apiKey: 'x', model: 'm' })
    const agent = agentWith(provider)
    const events = await collect(agent.send('halo'))
    assert.ok(events.some((event) => event.type === 'retry' && /upstream sibuk/.test(event.message)))
    assert.equal(agent.history.at(-1)?.content, 'pulih')
  } finally {
    server.close()
  }
})

test('HTTP: batas waktu dihitung sejak data terakhir, bukan sejak permintaan dimulai', async () => {
  const server = await serve((count, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    if (count === 1) {
      // Satu potongan, lalu diam.
      sse(response, 'mulai')
      return
    }
    // Mengalir 800 ms, lebih lama dari batas waktu, tetapi tidak pernah diam lama.
    let sent = 0
    const timer = setInterval(() => {
      sse(response, `${sent} `)
      sent += 1
      if (sent === 8) {
        clearInterval(timer)
        response.end('data: [DONE]\n\n')
      }
    }, 100)
  })
  try {
    const provider = new NineRouterProvider({ baseUrl: server.url, apiKey: 'x', model: 'm', timeoutMs: 300 })
    const silent = provider.stream([{ role: 'user', content: 'x' }], [])
    await assert.rejects(async () => {
      for (let next = await silent.next(); !next.done; next = await silent.next()) { /* habiskan */ }
    }, (error: unknown) => error instanceof ProviderError && error.retryable && /tidak mengirim data/.test(error.message))

    const flowing = provider.stream([{ role: 'user', content: 'x' }], [])
    let next = await flowing.next()
    while (!next.done) next = await flowing.next()
    assert.equal(next.value.message.content, '0 1 2 3 4 5 6 7 ')
  } finally {
    server.close()
  }
})

test('HTTP: error di tengah aliran dikenali', async () => {
  const server = await serve((_count, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.end(`data: ${JSON.stringify({ error: { message: '[antigravity/x] [429]: quota' } })}\n\n`)
  })
  try {
    const provider = new NineRouterProvider({ baseUrl: server.url, apiKey: 'x', model: 'm' })
    const stream = provider.stream([{ role: 'user', content: 'x' }], [])
    await assert.rejects(() => stream.next(), (error: unknown) => error instanceof ProviderError && error.retryable)
  } finally {
    server.close()
  }
})
