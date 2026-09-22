import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { NineRouterProvider } from '@boo/core'

const directory = mkdtempSync(join(tmpdir(), 'boo-web-fork-'))
process.env.HOME = directory
const { loadSession } = await import('@boo/core/session/sessions.ts')
const { WebController, ControllerError } = await import('../src/server/controller.ts')

function completedRequest(controller: InstanceType<typeof WebController>): Promise<void> {
  return new Promise((resolve) => {
    let started = false
    const unsubscribe = controller.subscribe((event) => {
      if (event.type === 'busy' && event.busy) started = true
      if (event.type === 'busy' && !event.busy && started) {
        unsubscribe()
        resolve()
      }
    })
  })
}

test('web mencabangkan percakapan lalu menyimpan kelanjutannya terpisah', { timeout: 5_000 }, async () => {
  const provider = new NineRouterProvider({ baseUrl: 'http://unused.invalid', apiKey: 'fake', model: 'ag/gemini-3.1-pro' })
  let reply = 'Jawaban awal.'
  provider.stream = async function* () {
    yield { type: 'text', delta: reply }
    return { message: { role: 'assistant', content: reply }, finishReason: 'stop' }
  }
  const controller = new WebController({
    workspace: directory,
    home: directory,
    config: { BOO_MODEL: 'ag/gemini-3.1-pro' },
    version: 'test',
    createProvider: () => provider,
  })
  try {
    assert.throws(() => controller.forkSession(), ControllerError)

    let done = completedRequest(controller)
    controller.submit('Pertanyaan awal')
    await done
    const sourceId = controller.snapshot().sessionId
    assert.ok(sourceId)

    controller.forkSession()
    const branchId = controller.snapshot().sessionId
    assert.ok(branchId)
    assert.notEqual(branchId, sourceId)
    assert.equal(loadSession(branchId).forkedFrom, sourceId)
    assert.deepEqual(loadSession(branchId).messages, loadSession(sourceId).messages)
    const lastItem = controller.snapshot().items.at(-1)
    assert.match(lastItem?.kind === 'notice' ? lastItem.text : '', /file workspace tetap dipakai bersama/)

    reply = 'Jawaban cabang.'
    done = completedRequest(controller)
    controller.submit('Eksperimen alternatif')
    await done
    assert.equal(loadSession(sourceId).messages.length, 2)
    assert.deepEqual(loadSession(branchId).messages.map((message) => message.content), [
      'Pertanyaan awal',
      'Jawaban awal.',
      'Eksperimen alternatif',
      'Jawaban cabang.',
    ])
    assert.equal(controller.sessions().length, 2)

    await controller.rewindSession(2)
    const rewindId = controller.snapshot().sessionId
    assert.ok(rewindId)
    assert.notEqual(rewindId, branchId)
    assert.equal(loadSession(rewindId).forkedFrom, branchId)
    assert.equal(loadSession(rewindId).forkedAtMessage, 2)
    assert.deepEqual(loadSession(rewindId).messages.map((message) => message.content), [
      'Pertanyaan awal',
      'Jawaban awal.',
    ])
    assert.equal(loadSession(branchId).messages.length, 4, 'sesi sebelum rewind tetap utuh')
    const rewindNotice = controller.snapshot().items.at(-1)
    assert.match(rewindNotice?.kind === 'notice' ? rewindNotice.text : '', /sebelum prompt #2/)
    await assert.rejects(() => controller.rewindSession(99), /tidak ditemukan/)

    const question = new Promise<NonNullable<ReturnType<typeof controller.snapshot>['question']>>((resolve) => {
      const unsubscribe = controller.subscribe((event) => {
        if (event.type === 'question' && event.question) {
          unsubscribe()
          resolve(event.question)
        }
      })
    })
    controller.submit('/rewind')
    const rewindQuestion = await question
    assert.match(rewindQuestion.prompt, /sebelum prompt mana/)
    assert.ok(rewindQuestion.options.some((option) => option.id === 'turn-1'))
    const switched = new Promise<void>((resolve) => {
      const unsubscribe = controller.subscribe((event) => {
        if (event.type === 'snapshot' && event.snapshot.sessionId !== rewindId) {
          unsubscribe()
          resolve()
        }
      })
    })
    assert.equal(controller.answer(rewindQuestion.id, 'turn-1'), true)
    await switched
    const emptyBranchId = controller.snapshot().sessionId
    assert.ok(emptyBranchId)
    assert.deepEqual(loadSession(emptyBranchId).messages, [])
    assert.equal(loadSession(rewindId).messages.length, 2)
    assert.equal(controller.sessions().length, 4)
  } finally {
    controller.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
