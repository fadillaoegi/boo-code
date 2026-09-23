import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { FailurePostmortemTracker, NineRouterProvider } from '@boo/core'
import type { ViewItem } from '@boo/core/presentation/view.ts'

const directory = mkdtempSync(join(tmpdir(), 'boo-web-postmortem-'))
process.env.HOME = directory
const { WebController } = await import('../src/server/controller.ts')

test('web /postmortem membaca diagnosis lokal tanpa memanggil provider', async () => {
  const tracker = new FailurePostmortemTracker({ workspace: directory, home: directory, model: 'test-model' })
  tracker.record({ type: 'turn-limit', turns: 40 })
  tracker.finish()
  let calls = 0
  const provider = new NineRouterProvider({ baseUrl: 'http://unused.invalid', apiKey: 'fake', model: 'test-model' })
  // eslint-disable-next-line require-yield
  provider.stream = async function* () { calls += 1; throw new Error('tidak boleh dipanggil') }
  const controller = new WebController({
    workspace: directory, home: directory, config: { BOO_MODEL: 'test-model' }, version: 'test', createProvider: () => provider,
  })
  try {
    const notice = new Promise<ViewItem>((resolve) => {
      const unsubscribe = controller.subscribe((event) => {
        if (event.type === 'item' && event.item.kind === 'notice' && event.item.text.startsWith('Postmortem ·')) {
          unsubscribe()
          resolve(event.item)
        }
      })
    })
    controller.submit('/postmortem')
    const item = await notice
    const text = item.kind === 'notice' ? item.text : ''
    assert.match(text, /stopped · turn-limit/)
    assert.match(text, /Periksa `\/status`/)
    assert.match(text, /prompt, source, argumen, output, dan path tidak disimpan/)
    assert.equal(calls, 0)
    assert.equal(controller.snapshot().items.some((entry) => entry.kind === 'user'), false)
  } finally {
    controller.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
