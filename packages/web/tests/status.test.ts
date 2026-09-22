import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { NineRouterProvider } from '@boo/core'
import type { ViewItem } from '@boo/core/presentation/view.ts'

const directory = mkdtempSync(join(tmpdir(), 'boo-web-status-'))
process.env.HOME = directory
const { WebController } = await import('../src/server/controller.ts')

test('web /status merangkum task lokal tanpa memanggil provider lagi', async () => {
  let calls = 0
  const provider = new NineRouterProvider({ baseUrl: 'http://unused.invalid', apiKey: 'fake', model: 'test-model', reasoningEffort: 'medium' })
  provider.stream = async function* () {
    calls += 1
    yield { type: 'text', delta: 'Selesai.' }
    return { message: { role: 'assistant', content: 'Selesai.' }, finishReason: 'stop' }
  }
  const controller = new WebController({
    workspace: directory, home: directory,
    config: { BOO_MODEL: 'test-model', BOO_EFFORT: 'medium' },
    version: 'test', createProvider: () => provider,
  })
  try {
    const completed = new Promise<void>((resolve) => {
      let started = false
      const unsubscribe = controller.subscribe((event) => {
        if (event.type === 'busy' && event.busy) started = true
        if (event.type === 'busy' && !event.busy && started) { unsubscribe(); resolve() }
      })
    })
    controller.submit('jelaskan status proyek')
    await completed

    const notice = new Promise<ViewItem>((resolve) => {
      const unsubscribe = controller.subscribe((event) => {
        if (event.type === 'item' && event.item.kind === 'notice' && event.item.text.startsWith('Task ·')) {
          unsubscribe()
          resolve(event.item)
        }
      })
    })
    controller.submit('/status')
    const item = await notice
    const text = item.kind === 'notice' ? item.text : ''
    assert.match(text, /Task · selesai/)
    assert.match(text, /Tujuan: jelaskan status proyek/)
    assert.match(text, /Model: test-model · reasoning medium/)
    assert.match(text, /Verifikasi: belum diperlukan/)
    assert.equal(calls, 1)
    assert.equal(controller.snapshot().items.filter((entry) => entry.kind === 'user').length, 1)
  } finally {
    controller.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
