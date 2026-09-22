import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { QuestionView } from '../src/protocol.ts'

const root = mkdtempSync(join(tmpdir(), 'boo-web-restore-'))
const home = join(root, 'home')
const workspace = join(root, 'workspace')
mkdirSync(join(home, '.boo'), { recursive: true })
mkdirSync(workspace, { recursive: true })
writeFileSync(join(home, '.boo', 'permissions.json'), JSON.stringify({
  version: 1,
  rules: [{ id: 'test-files', effect: 'allow', tool: 'write_file', path: '**' }],
}))
process.env.HOME = home
const { NineRouterProvider } = await import('@boo/core')
const { WebController } = await import('../src/server/controller.ts')

function completed(controller: InstanceType<typeof WebController>, submit: () => void): Promise<void> {
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

test('web meninjau lalu memulihkan checkpoint lama tanpa mengubah percakapan', { timeout: 5_000 }, async () => {
  const provider = new NineRouterProvider({ baseUrl: 'http://unused.invalid', apiKey: 'fake', model: 'test-model' })
  let turn = 0
  provider.stream = async function* () {
    turn += 1
    if (turn === 1 || turn === 3) {
      const second = turn === 3
      return {
        finishReason: 'tool_calls',
        message: {
          role: 'assistant' as const,
          content: null,
          tool_calls: second
            ? [
                { id: 'second-a', type: 'function' as const, function: { name: 'write_file', arguments: JSON.stringify({ path: 'state.txt', content: 'v2\n' }) } },
                { id: 'second-b', type: 'function' as const, function: { name: 'write_file', arguments: JSON.stringify({ path: 'new.txt', content: 'baru\n' }) } },
              ]
            : [{ id: 'first', type: 'function' as const, function: { name: 'write_file', arguments: JSON.stringify({ path: 'state.txt', content: 'v1\n' }) } }],
        },
      }
    }
    const content = 'Selesai.'
    yield { type: 'text', delta: content }
    return { finishReason: 'stop', message: { role: 'assistant', content } }
  }
  const controller = new WebController({
    workspace,
    home,
    config: { BOO_MODEL: 'test-model' },
    version: 'test',
    createProvider: () => provider,
  })
  try {
    await completed(controller, () => controller.submit('buat versi pertama'))
    await completed(controller, () => controller.submit('buat versi kedua'))
    assert.equal(readFileSync(join(workspace, 'state.txt'), 'utf8'), 'v2\n')

    const question = new Promise<QuestionView>((resolve) => {
      const unsubscribe = controller.subscribe((event) => {
        if (event.type === 'question' && event.question) {
          unsubscribe()
          resolve(event.question)
        }
      })
    })
    controller.submit('/restore 2')
    const review = await question
    assert.equal(review.title, 'Konfirmasi restore workspace')
    assert.match(review.prompt, /2 file.*1 checkpoint/)
    assert.equal(review.body?.type, 'undo')

    const restored = new Promise<void>((resolve) => {
      const unsubscribe = controller.subscribe((event) => {
        if (event.type === 'item' && event.item.kind === 'notice' && /checkpoint dilepas/.test(event.item.text)) {
          unsubscribe()
          resolve()
        }
      })
    })
    assert.equal(controller.answer(review.id, 'restore'), true)
    await restored
    assert.equal(readFileSync(join(workspace, 'state.txt'), 'utf8'), 'v1\n')
    assert.equal(existsSync(join(workspace, 'new.txt')), false)
    assert.equal(controller.snapshot().items.filter((item) => item.kind === 'user').length, 2)
  } finally {
    controller.close()
    rmSync(root, { recursive: true, force: true })
  }
})
