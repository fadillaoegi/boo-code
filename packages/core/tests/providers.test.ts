import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { streamAnthropic, toAnthropicRequest, toAnthropicTools } from '../src/provider/anthropic.ts'
import { groupModels, humanizeModel, acceptedEffort } from '../src/provider/models.ts'
import { NineRouterProvider } from '../src/provider/nineRouter.ts'
import { profilesFromConfig, qualifyModelId, splitModelId, type ProviderProfile } from '../src/provider/profiles.ts'

/* ------------------------------------------------------------ id dan profil */

test('awalan penyedia dipisahkan hanya bila dikenal', () => {
  assert.deepEqual(splitModelId('anthropic:claude-sonnet-4-6'), { providerId: 'anthropic', model: 'claude-sonnet-4-6' })
  assert.deepEqual(splitModelId('ag/claude-sonnet-4-6'), { providerId: null, model: 'ag/claude-sonnet-4-6' })
  // Tag Ollama memakai titik dua juga; hanya awalan pertama yang dipotong.
  assert.deepEqual(splitModelId('ollama:qwen2.5-coder:7b'), { providerId: 'ollama', model: 'qwen2.5-coder:7b' })
  assert.deepEqual(splitModelId('mistral:latest'), { providerId: null, model: 'mistral:latest' })

  assert.equal(qualifyModelId('anthropic', 'claude-sonnet-4-6'), 'anthropic:claude-sonnet-4-6')
  assert.equal(qualifyModelId('ninerouter', 'ag/gemini-3.7-flash'), 'ag/gemini-3.7-flash')
})

test('penyedia dibaca dari setelan; yang tanpa kunci atau alamat dilewati', () => {
  const profiles = profilesFromConfig({
    NINEROUTER_KEY: 'router',
    ANTHROPIC_API_KEY: 'anthropic-key',
    OPENAI_API_KEY: '',
    OLLAMA_BASE_URL: 'http://localhost:11434/v1',
    CUSTOM_API_KEY: 'tanpa-alamat',
  })
  assert.deepEqual(profiles.map((profile) => profile.id), ['ninerouter', 'anthropic', 'ollama'])
  assert.equal(profiles[0].baseUrl, 'http://localhost:20128', 'alamat bawaan dipakai bila tidak diisi')
  assert.equal(profiles[1].wire, 'anthropic')
  assert.equal(profiles[2].apiKey, '', 'penyedia lokal tidak memerlukan kunci')
  assert.deepEqual(profilesFromConfig({}), [])
})

test('model dari penyedia lain disebut bersama penyedianya, dan Claude menerima tingkat penalaran', () => {
  assert.equal(humanizeModel('anthropic:claude-sonnet-4-6'), 'Anthropic · Claude Sonnet 4.6')
  assert.equal(humanizeModel('ag/claude-sonnet-4-6'), 'Claude Sonnet 4.6')

  const [family] = groupModels(['anthropic:claude-sonnet-4-6'])
  assert.equal(family.source, 'parameter')
  assert.deepEqual(family.options.map((option) => option.level), ['low', 'medium', 'high', 'xhigh'])
  assert.equal(acceptedEffort('anthropic:claude-sonnet-4-6', 'high'), 'high')
  assert.equal(acceptedEffort('anthropic:claude-haiku-4-5', 'high'), undefined, 'model tanpa mode berpikir tidak menawarkan tingkat')
})

/* ------------------------------------------------------ penerjemahan Anthropic */

test('percakapan gaya OpenAI menjadi bentuk Anthropic', () => {
  const { system, messages } = toAnthropicRequest([
    { role: 'system', content: 'Kamu Boo.' },
    { role: 'user', content: 'baca app.ts' },
    { role: 'assistant', content: 'Saya baca dulu.', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"app.ts"}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'isi berkas' },
    { role: 'tool', tool_call_id: 'c2', content: 'isi kedua' },
    { role: 'assistant', content: 'Sudah.' },
  ])
  assert.equal(system, 'Kamu Boo.')
  assert.deepEqual(messages.map((message) => message.role), ['user', 'assistant', 'user', 'assistant'])
  assert.deepEqual(messages[1].content, [
    { type: 'text', text: 'Saya baca dulu.' },
    { type: 'tool_use', id: 'c1', name: 'read_file', input: { path: 'app.ts' } },
  ])
  // Dua hasil tool berturut-turut menjadi satu pesan pengguna.
  assert.deepEqual(messages[2].content, [
    { type: 'tool_result', tool_use_id: 'c1', content: 'isi berkas' },
    { type: 'tool_result', tool_use_id: 'c2', content: 'isi kedua' },
  ])
})

test('gambar dan skema tool ikut diterjemahkan', () => {
  const { messages } = toAnthropicRequest([
    { role: 'user', content: [{ type: 'text', text: 'lihat ini' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAB' } }] },
  ])
  assert.deepEqual(messages[0].content, [
    { type: 'text', text: 'lihat ini' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAB' } },
  ])

  assert.deepEqual(toAnthropicTools([{ type: 'function', function: { name: 'grep', description: 'cari', parameters: { type: 'object', properties: {} } } }]), [
    { name: 'grep', description: 'cari', input_schema: { type: 'object', properties: {} } },
  ])
})

/* ------------------------------------------------------------- HTTP sungguhan */

async function serve(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  return { url: `http://127.0.0.1:${port}`, close: () => { server.closeAllConnections(); server.close() } }
}

function sse(response: ServerResponse, events: unknown[]) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' })
  for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`)
  response.end()
}

test('aliran Anthropic menghasilkan teks, penalaran, dan pemanggilan tool', async () => {
  let seen: { headers: IncomingMessage['headers']; body: Record<string, unknown> } | null = null
  const server = await serve(async (request, response) => {
    let raw = ''
    for await (const chunk of request) raw += chunk
    seen = { headers: request.headers, body: JSON.parse(raw) as Record<string, unknown> }
    sse(response, [
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'menimbang' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Saya baca berkasnya.' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_1', name: 'read_file' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"app.ts"}' } },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      { type: 'message_stop' },
    ])
  })
  try {
    const profile: ProviderProfile = { id: 'anthropic', label: 'Anthropic', baseUrl: server.url, apiKey: 'kunci-rahasia', wire: 'anthropic' }
    const stream = streamAnthropic({
      profile,
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'baca app.ts' }],
      tools: [{ type: 'function', function: { name: 'read_file', description: 'baca', parameters: { type: 'object', properties: {} } } }],
      reasoningEffort: 'high',
      timeoutMs: 5_000,
    })
    const events = []
    let next = await stream.next()
    while (!next.done) {
      events.push(next.value)
      next = await stream.next()
    }

    assert.deepEqual(events, [
      { type: 'reasoning', delta: 'menimbang' },
      { type: 'text', delta: 'Saya baca berkasnya.' },
      { type: 'tool-call', index: 1, name: 'read_file', delta: '' },
      { type: 'tool-call', index: 1, name: 'read_file', delta: '{"path":' },
      { type: 'tool-call', index: 1, name: 'read_file', delta: '"app.ts"}' },
    ])
    assert.equal(next.value.finishReason, 'tool_calls')
    assert.deepEqual(next.value.message.tool_calls, [{ id: 'tu_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"app.ts"}' } }])
    assert.equal(next.value.message.content, 'Saya baca berkasnya.')
    assert.equal(next.value.message.reasoning_content, 'menimbang')

    const request = seen as unknown as { headers: Record<string, string>; body: Record<string, unknown> }
    assert.equal(request.headers['x-api-key'], 'kunci-rahasia')
    assert.equal(request.headers['anthropic-version'], '2023-06-01')
    assert.equal(request.body.model, 'claude-sonnet-4-6')
    assert.deepEqual(request.body.thinking, { type: 'enabled', budget_tokens: 16_384 })
    assert.ok(Number(request.body.max_tokens) > 16_384, 'batas keluaran harus melebihi anggaran berpikir')
  } finally {
    server.close()
  }
})

test('gerbang model memilih penyedia dari awalan id model', async () => {
  const hits: string[] = []
  const anthropic = await serve(async (request, response) => {
    hits.push(`anthropic ${request.url}`)
    for await (const chunk of request) void chunk
    sse(response, [
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'halo dari Claude' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    ])
  })
  const router = await serve(async (request, response) => {
    hits.push(`router ${request.url}`)
    for await (const chunk of request) void chunk
    if (request.url?.includes('/models')) {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ data: [{ id: 'ag/claude-sonnet-4-6' }] }))
      return
    }
    sse(response, [{ choices: [{ delta: { content: 'halo dari 9Router' } }] }])
  })
  try {
    const provider = new NineRouterProvider({
      baseUrl: router.url,
      apiKey: 'router-key',
      model: 'ag/claude-sonnet-4-6',
      profiles: [
        { id: 'ninerouter', label: '9Router', baseUrl: router.url, apiKey: 'router-key', wire: 'openai' },
        { id: 'anthropic', label: 'Anthropic', baseUrl: anthropic.url, apiKey: 'anthropic-key', wire: 'anthropic' },
      ],
    })

    const drain = async () => {
      const stream = provider.stream([{ role: 'user', content: 'halo' }], [])
      let next = await stream.next()
      while (!next.done) next = await stream.next()
      return next.value
    }

    assert.equal((await drain()).message.content, 'halo dari 9Router')
    provider.model = 'anthropic:claude-sonnet-4-6'
    assert.equal((await drain()).message.content, 'halo dari Claude')
    assert.ok(hits.some((hit) => hit.startsWith('anthropic /v1/messages')), hits.join(', '))

    // Penyedia yang bermasalah tidak menutup daftar model penyedia lain.
    assert.deepEqual(await provider.listModels(), ['ag/claude-sonnet-4-6'])

    provider.model = 'openai:gpt-5.6'
    await assert.rejects(() => drain(), /belum dikonfigurasi/)
  } finally {
    anthropic.close()
    router.close()
  }
})
