import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { NineRouterProvider } from '@boo/core'

// Isolasi rekaman sesi sebelum controller/sessions diimpor.
const directory = mkdtempSync(join(tmpdir(), 'boo-web-auto-'))
process.env.HOME = directory
const { WebController, ControllerError } = await import('../src/server/controller.ts')

test('web Auto mengirim mode/model aktual ke semua tab, tersimpan saat resume', { timeout: 5_000 }, async () => {
  const provider = new NineRouterProvider({ baseUrl: 'http://unused.invalid', apiKey: 'fake', model: 'ag/gemini-3.1-pro' })
  provider.listModels = async () => ['ag/gemini-3.1-pro', 'cx/gpt-5.6-sol']
  provider.fork = () => {
    const judge = new NineRouterProvider({ baseUrl: 'http://unused.invalid', apiKey: 'fake', model: 'judge' })
    judge.stream = async function* () {
      const content = '{"difficulty":"expert","reason":"Migrasi arsitektur besar."}'
      yield { type: 'text', delta: content }
      return { message: { role: 'assistant', content }, finishReason: 'stop' }
    }
    return judge
  }
  provider.stream = async function* () {
    assert.equal(provider.model, 'cx/gpt-5.6-sol')
    assert.equal(provider.reasoningEffort, 'xhigh')
    yield { type: 'text', delta: 'Selesai.' }
    return { message: { role: 'assistant', content: 'Selesai.' }, finishReason: 'stop' }
  }
  const controller = new WebController({ workspace: directory, home: directory, config: {}, version: 'test', createProvider: () => provider })
  try {
    assert.equal(controller.snapshot().model.mode, 'auto')
    assert.equal(controller.snapshot().model.label, 'Auto · menunggu tugas')
    assert.notEqual(controller.snapshot().model.id, 'auto')
    let busyStarted = false
    let modelChangeBlocked = false
    const completed = new Promise<void>((resolve) => {
      const unsubscribe = controller.subscribe((event) => {
        if (event.type === 'busy' && event.busy) {
          busyStarted = true
          try { controller.setModel('ag/gemini-3.1-pro', null) } catch (error) { modelChangeBlocked = error instanceof ControllerError }
        }
        if (event.type === 'busy' && !event.busy && busyStarted) { unsubscribe(); resolve() }
      })
    })
    const observed: string[] = []
    controller.subscribe((event) => { if (event.type === 'model') observed.push(event.model.label) })
    controller.submit('Migrasi arsitektur distributed dan security')
    await completed
    assert.equal(modelChangeBlocked, true, 'model tidak berubah selama routing/task berjalan')
    const current = controller.snapshot()
    assert.equal(current.model.id, 'cx/gpt-5.6-sol')
    assert.equal(current.model.effort, 'xhigh')
    assert.match(observed[0], /^Auto · GPT-5\.6 Sol/)
    assert.ok(current.sessionId)
    controller.newSession()
    controller.setModel('ag/gemini-3.1-pro', null)
    assert.equal(controller.snapshot().model.mode, 'manual')
    controller.resumeSession(current.sessionId)
    assert.equal(controller.snapshot().model.mode, 'auto')
    assert.equal(controller.snapshot().model.id, 'cx/gpt-5.6-sol')
    controller.setModel('ag/gemini-3.1-pro', null)
    assert.equal(controller.snapshot().model.mode, 'manual')
    assert.equal(controller.snapshot().model.effort, null)
  } finally {
    controller.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
