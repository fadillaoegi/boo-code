import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { Message, ToolSchema } from '@boo/core'
import type { WebController as WebControllerType } from '../src/server/controller.ts'

// SessionRecorder menentukan lokasi dari HOME saat modul dimuat.
const directory = mkdtempSync(join(tmpdir(), 'boo-web-plan-'))
process.env.HOME = directory
const { IMPLEMENT_PLAN_PROMPT_MARK, NineRouterProvider, PLAN_PROMPT_MARK } = await import('@boo/core')
const { WebController } = await import('../src/server/controller.ts')

function completed(controller: WebControllerType, submit: () => void): Promise<void> {
  return new Promise((resolve) => {
    let started = false
    const unsubscribe = controller.subscribe((event) => {
      if (event.type === 'busy' && event.busy) started = true
      if (event.type === 'busy' && !event.busy && started) {
        unsubscribe()
        resolve()
      }
    })
    submit()
  })
}

test('web menjalankan /plan read-only lalu /implement dengan registry normal', async () => {
  const workspace = directory
  const provider = new NineRouterProvider({ baseUrl: 'http://unused.invalid', apiKey: 'fake', model: 'test-model' })
  const schemas: string[][] = []
  const prompts: string[] = []
  provider.stream = async function* (messages: Message[], tools: ToolSchema[]) {
    schemas.push(tools.map((tool) => tool.function.name))
    prompts.push(messages.filter((message) => message.role === 'user').at(-1)?.content ?? '')
    const planning = prompts.at(-1)?.startsWith(PLAN_PROMPT_MARK)
    const content = planning ? '1. Ubah cache.ts.\n2. Jalankan test.' : 'Implementasi selesai.'
    yield { type: 'text', delta: content }
    return { message: { role: 'assistant', content }, finishReason: 'stop' }
  }
  const controller = new WebController({
    workspace,
    home: workspace,
    config: { BOO_MODEL: 'test-model' },
    version: 'test',
    createProvider: () => provider,
  })

  try {
    await completed(controller, () => controller.submit('/plan tambahkan cache'))
    assert.ok(schemas[0], JSON.stringify(controller.snapshot().items))
    assert.ok(schemas[0].includes('read_file'))
    assert.ok(!schemas[0].includes('write_file'))
    assert.equal(controller.snapshot().items.find((item) => item.kind === 'user')?.text, '/plan tambahkan cache')

    await completed(controller, () => controller.submit('/implement'))
    assert.ok(schemas[1].includes('write_file'))
    assert.ok(prompts[1].startsWith(IMPLEMENT_PLAN_PROMPT_MARK))
    assert.match(prompts[1], /1\. Ubah cache\.ts/)
    assert.equal(controller.snapshot().items.filter((item) => item.kind === 'user').at(-1)?.text, '/implement')
  } finally {
    controller.close()
    rmSync(workspace, { recursive: true, force: true })
  }
})
