import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { NineRouterProvider } from '@boo/core'
import type { ViewItem } from '@boo/core/presentation/view.ts'

const directory = mkdtempSync(join(tmpdir(), 'boo-web-context-'))
process.env.HOME = directory
const { WebController } = await import('../src/server/controller.ts')

test('web /context melaporkan budget lokal tanpa memanggil provider atau mengubah percakapan', async () => {
  const provider = new NineRouterProvider({ baseUrl: 'http://unused.invalid', apiKey: 'fake', model: 'test-model' })
  // eslint-disable-next-line require-yield
  provider.stream = async function* () {
    throw new Error('provider tidak boleh dipanggil oleh /context')
  }
  const controller = new WebController({
    workspace: directory,
    home: directory,
    config: { BOO_MODEL: 'test-model', BOO_MAX_CONTEXT_TOKENS: '100000' },
    version: 'test',
    createProvider: () => provider,
  })
  try {
    const notice = new Promise<ViewItem>((resolve) => {
      const unsubscribe = controller.subscribe((event) => {
        if (event.type === 'item' && event.item.kind === 'notice' && event.item.text.startsWith('Konteks model')) {
          unsubscribe()
          resolve(event.item)
        }
      })
    })
    controller.submit('/context')
    const item = await notice

    assert.match(item.kind === 'notice' ? item.text : '', /Dikirim .*100\.000 token/)
    assert.match(item.kind === 'notice' ? item.text : '', /skema tool/i)
    assert.equal(controller.snapshot().items.some((entry) => entry.kind === 'user'), false)
  } finally {
    controller.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
