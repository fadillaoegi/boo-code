import assert from 'node:assert/strict'
import test from 'node:test'
import { Agent, CANCELLED_REPLY, type AgentEvent } from '../src/agent/loop.ts'
import { createRegistry } from '../src/domain/tool.ts'
import type { Message } from '../src/domain/message.ts'
import { assessLocally, AutoModelRouter, parseAssessment, selectAutoModel } from '../src/provider/auto.ts'
import { NineRouterProvider } from '../src/provider/nineRouter.ts'
import type { AutoPerformanceProfile } from '../src/provider/performance.ts'

const IDS = ['ag/gemini-3.7-flash-low', 'ag/gemini-3.7-flash-medium', 'ag/gemini-3.7-flash-high', 'ag/gemini-3.1-pro', 'cx/gpt-5.6-sol', 'ag/claude-opus-4-6-thinking']

function fakeProvider(options: { assessments?: string[]; discoveryError?: boolean; wait?: boolean; ids?: string[]; failModels?: string[]; rejectImages?: string[] } = {}) {
  const selections: { model: string; effort?: string }[] = []
  const judges: Message[][] = []
  let discoveries = 0
  const provider = new NineRouterProvider({ baseUrl: 'http://unused.invalid', apiKey: 'fake', model: 'ag/gemini-3.1-pro' })
  provider.listModels = async () => {
    discoveries += 1
    if (options.discoveryError) throw new Error('offline')
    return options.ids ?? IDS
  }
  provider.fork = () => {
    const evaluator = new NineRouterProvider({ baseUrl: 'http://unused.invalid', apiKey: 'fake', model: 'judge' })
    evaluator.stream = async function* (messages, tools, signal) {
      assert.deepEqual(tools, [], 'penilai tidak boleh menjalankan tool')
      judges.push(messages)
      if (options.wait) await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }))
      signal?.throwIfAborted()
      const content = options.assessments?.shift() ?? '{"difficulty":"standard","reason":"Fitur rutin satu modul."}'
      yield { type: 'text', delta: content }
      return { message: { role: 'assistant', content }, finishReason: 'stop' }
    }
    return evaluator
  }
  provider.stream = async function* (messages) {
    if (options.failModels?.includes(provider.model)) {
      throw new (await import('../src/provider/nineRouter.ts')).ProviderError('Model upstream tidak ditemukan.', { status: 404, retryable: false })
    }
    if (options.rejectImages?.includes(provider.model) && messages.some((message) => message.images?.length)) {
      throw new (await import('../src/provider/nineRouter.ts')).ProviderError('Model does not support image_url vision input.', { status: 400, retryable: false })
    }
    selections.push({ model: provider.model, effort: provider.reasoningEffort })
    yield { type: 'text', delta: 'selesai' }
    return { message: { role: 'assistant', content: 'selesai' }, finishReason: 'stop' }
  }
  return { provider, selections, judges, discoveries: () => discoveries }
}

function createAgent(provider: NineRouterProvider, mode: 'auto' | 'manual' = 'auto') {
  return new Agent({ provider, modelMode: mode, workspace: '/unused', registry: createRegistry([]), askPermission: async () => true })
}

async function collect(events: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const found: AgentEvent[] = []
  for await (const event of events) found.push(event)
  return found
}

test('routing memilih model dan tingkat sesuai difficulty, hanya dari daftar tersedia', () => {
  assert.equal(selectAutoModel(IDS, 'simple')?.modelId, 'ag/gemini-3.7-flash-low')
  assert.equal(selectAutoModel(IDS, 'standard')?.modelId, 'ag/gemini-3.1-pro')
  assert.deepEqual(selectAutoModel(IDS, 'complex'), { level: 'high', label: 'High', modelId: 'cx/gpt-5.6-sol', reasoningEffort: 'high' })
  assert.equal(selectAutoModel(IDS, 'expert')?.reasoningEffort, 'xhigh')
  assert.equal(selectAutoModel(IDS.filter((id) => id !== 'cx/gpt-5.6-sol'), 'expert')?.modelId, 'ag/claude-opus-4-6-thinking')
  assert.equal(selectAutoModel(['ag/gemini-3.1-pro'], 'expert')?.reasoningEffort, undefined)
  assert.equal(selectAutoModel(['cx/gpt-5.6-terra'], 'expert')?.reasoningEffort, 'xhigh')
  assert.equal(selectAutoModel(['ag/gemini-3.5-flash-low', 'ag/gemini-3.5-flash-high'], 'standard')?.modelId, 'ag/gemini-3.5-flash-high')
  assert.equal(selectAutoModel(['unknown'], 'complex'), null)
  assert.equal(selectAutoModel(['unknown'], 'complex', 'unknown')?.modelId, 'unknown')
})

test('Auto memakai profil eval yang cukup kuat dan tetap menampilkan alasannya', async () => {
  const now = Date.now()
  const profile: AutoPerformanceProfile = {
    schemaVersion: 1,
    updatedAt: now,
    stats: [
      { model: 'ag/gemini-3.1-pro', difficulty: 'standard', tag: '*', samples: 4, passes: 2, scoreTotal: 260, durationMsTotal: 4_000, retries: 2, toolFailures: 2, updatedAt: now },
      { model: 'ag/claude-opus-4-6-thinking', difficulty: 'standard', tag: '*', samples: 4, passes: 4, scoreTotal: 400, durationMsTotal: 5_000, retries: 0, toolFailures: 0, updatedAt: now },
    ],
  }
  const fake = fakeProvider()
  const selected = await new AutoModelRouter({ performance: profile, now: () => now }).route(fake.provider, 'Buat fitur rutin', [])
  assert.equal(selected.model, 'ag/claude-opus-4-6-thinking')
  assert.equal(selected.routingPolicy, 'evaluation')
  assert.equal(selected.performanceSamples, 4)
  assert.match(selected.reason, /Profil eval lokal/)
})

test('penilai menerima JSON terbatas, bukan model/effort arbitrer; teks panjang tidak otomatis berat', () => {
  assert.equal(parseAssessment('```json\n{"difficulty":"complex","reason":"Migrasi lintas modul."}\n```')?.difficulty, 'complex')
  assert.equal(parseAssessment('{"difficulty":"invented","reason":"x"}'), null)
  assert.equal(parseAssessment('{"difficulty":"expert","reason":12}'), null)
  assert.equal(parseAssessment('{"difficulty":"expert","reason":""}'), null)
  assert.equal(parseAssessment('not json'), null)
  assert.equal(assessLocally('Jelaskan log ini\n' + 'a'.repeat(12_000)).difficulty, 'standard')
  assert.equal(assessLocally('Refactor arsitektur concurrency distributed').difficulty, 'expert')
  assert.equal(assessLocally('ubah warna tombol').difficulty, 'simple')
})

test('Auto menilai ulang setiap task, memakai konteks, tidak menambahkan jawaban classifier ke history', async () => {
  const fake = fakeProvider({ assessments: ['{"difficulty":"expert","reason":"Migrasi besar dan keamanan."}', '{"difficulty":"simple","reason":"Mengganti judul."}'] })
  const agent = createAgent(fake.provider)
  const heavy = await collect(agent.send('Migrasikan sistem autentikasi lintas modul'))
  assert.ok(heavy.some((event) => event.type === 'model-selected' && event.difficulty === 'expert'))
  await collect(agent.send('ubah judul tombol'))
  assert.deepEqual(fake.selections, [
    { model: 'cx/gpt-5.6-sol', effort: 'xhigh' },
    { model: 'ag/gemini-3.7-flash-low', effort: undefined },
  ])
  assert.equal(fake.discoveries(), 1, 'discovery dicache, penilaian task tidak')
  assert.equal(agent.history.filter((message) => message.role !== 'system').length, 4)
  const context = JSON.parse(fake.judges[1][1].content ?? '{}') as { previousPrompts: string[] }
  assert.deepEqual(context.previousPrompts, ['Migrasikan sistem autentikasi lintas modul'])
})

test('lanjutkan tetap memakai difficulty sebelumnya, tugas baru dapat turun ke model ringan', async () => {
  const fake = fakeProvider({ assessments: ['{"difficulty":"complex","reason":"Refactor."}', '{"difficulty":"simple","reason":"Pesan pendek."}'] })
  const router = new AutoModelRouter()
  await router.route(fake.provider, 'Refactor modul', [])
  const selected = await router.route(fake.provider, 'oke lanjutkan', [])
  assert.equal(selected.difficulty, 'complex')
  assert.equal(selected.reasoningEffort, 'high')
})

test('lanjutkan dengan cakupan baru tetap dinilai ulang, tidak terkunci pada task ringan', async () => {
  const fake = fakeProvider({ assessments: ['{"difficulty":"simple","reason":"Teks tombol."}', '{"difficulty":"expert","reason":"Arsitektur keamanan baru."}'] })
  const router = new AutoModelRouter()
  await router.route(fake.provider, 'ubah teks tombol', [])
  const selected = await router.route(fake.provider, 'lanjutkan dengan migrasi arsitektur keamanan distributed', [])
  assert.equal(selected.difficulty, 'expert')
  assert.equal(selected.reasoningEffort, 'xhigh')
})

test('manual tidak melakukan discovery/classifier dan bisa dipilih kembali setelah Auto', async () => {
  const fake = fakeProvider()
  const agent = createAgent(fake.provider, 'manual')
  await collect(agent.send('Migrasi distributed systems'))
  assert.equal(fake.judges.length, 0)
  assert.equal(fake.discoveries(), 0)
  agent.setModelMode('auto')
  await collect(agent.send('Fitur rutin'))
  assert.equal(fake.judges.length, 1)
  agent.setModelMode('manual')
  fake.provider.model = 'cx/gpt-5.6-terra'
  fake.provider.reasoningEffort = 'low'
  await collect(agent.send('Task besar'))
  assert.deepEqual(fake.selections.at(-1), { model: 'cx/gpt-5.6-terra', effort: 'low' })
  assert.equal(fake.judges.length, 1)
})

test('penilai gagal memakai fallback lokal; discovery gagal memakai model terakhir', async () => {
  const fake = fakeProvider({ assessments: ['invalid'] })
  const events = await collect(createAgent(fake.provider).send('Refactor arsitektur keamanan'))
  assert.ok(events.some((event) => event.type === 'model-selected' && event.source === 'local' && event.model === 'cx/gpt-5.6-sol'))
  const offline = fakeProvider({ discoveryError: true })
  await collect(createAgent(offline.provider).send('Refactor'))
  assert.deepEqual(offline.selections, [{ model: 'ag/gemini-3.1-pro', effort: undefined }])
  assert.equal(offline.judges.length, 0)
})

test('Auto mengarantina model 404 lalu melanjutkan task dengan model cadangan', async () => {
  const fake = fakeProvider({ failModels: ['ag/gemini-3.1-pro'] })
  const agent = createAgent(fake.provider)
  const events = await collect(agent.send('Buat fitur rutin'))
  const selected = events.filter((event): event is Extract<AgentEvent, { type: 'model-selected' }> => event.type === 'model-selected')
  assert.equal(selected.length, 2)
  assert.equal(selected[0].model, 'ag/gemini-3.1-pro')
  assert.equal(selected[1].model, 'cx/gpt-5.6-sol')
  assert.equal(fake.selections.at(-1)?.model, 'cx/gpt-5.6-sol')
  assert.match(selected[1].reason, /ditolak upstream/)
  assert.equal(agent.history.at(-1)?.content, 'selesai')
})

test('Auto memberi sinyal multimodal ke penilai dan pindah bila model menolak gambar', async () => {
  const fake = fakeProvider({ rejectImages: ['ag/gemini-3.1-pro'] })
  const agent = createAgent(fake.provider)
  const image = { id: 'a'.repeat(20), name: 'ui.png', mediaType: 'image/png' as const, ref: `session-12345678/${'a'.repeat(64)}.png`, bytes: 100 }
  const events = await collect(agent.send('Periksa UI ini', { images: [image] }))
  const selected = events.filter((event): event is Extract<AgentEvent, { type: 'model-selected' }> => event.type === 'model-selected')
  assert.equal(selected.length, 2)
  assert.equal(selected[0].model, 'ag/gemini-3.1-pro')
  assert.equal(selected[1].model, 'cx/gpt-5.6-sol')
  assert.match(fake.judges[0][1].content ?? '', /image attachment/)
  assert.equal(agent.history.at(-1)?.content, 'selesai')
})

test('daftar kosong tidak mengirim model auto sebagai id upstream dan riwayat tetap sah', async () => {
  const fake = fakeProvider({ ids: [] })
  const agent = createAgent(fake.provider)
  const events = await collect(agent.send('fitur baru'))
  assert.ok(events.some((event) => event.type === 'error'))
  assert.equal(fake.selections.length, 0)
  assert.equal(agent.history.at(-1)?.role, 'assistant')
})

test('pembatalan saat memilih model tidak menjalankan task dan menutup history', async () => {
  const fake = fakeProvider({ wait: true })
  const agent = createAgent(fake.provider)
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), 30)
  try {
    const events = await collect(agent.send('task', { signal: abort.signal }))
    assert.ok(events.some((event) => event.type === 'cancelled'))
    assert.equal(fake.selections.length, 0)
    assert.equal(agent.history.at(-1)?.content, CANCELLED_REPLY)
  } finally {
    clearTimeout(timer)
  }
})
