import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { Message } from '@boo/core'

const directory = mkdtempSync(join(tmpdir(), 'boo-web-steering-'))
process.env.HOME = directory
const { NineRouterProvider, USER_STEERING_MARK } = await import('@boo/core')
const { WebController } = await import('../src/server/controller.ts')

test('web mengirim teks saat sibuk sebagai steering, bukan task antrean', async () => {
  let release!: () => void
  let started!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const modelStarted = new Promise<void>((resolve) => { started = resolve })
  const seen: Message[][] = []
  let turn = 0
  const provider = new NineRouterProvider({ baseUrl: 'http://unused.invalid', apiKey: 'fake', model: 'test-model' })
  provider.stream = function (messages: Message[]) {
    seen.push(messages)
    turn += 1
    if (turn === 1) {
      // eslint-disable-next-line require-yield
      return (async function* () {
        started()
        await gate
        return {
          finishReason: 'tool_calls',
          message: {
            role: 'assistant' as const,
            content: null,
            tool_calls: [{ id: 'stale', type: 'function' as const, function: { name: 'write_file', arguments: '{"path":"old.txt","content":"old"}' } }],
          },
        }
      })()
    }
    return (async function* () {
      yield { type: 'text' as const, delta: 'Arah baru diterapkan.' }
      return { finishReason: 'stop', message: { role: 'assistant' as const, content: 'Arah baru diterapkan.' } }
    })()
  }
  const controller = new WebController({
    workspace: directory, home: directory,
    config: { BOO_MODEL: 'test-model' }, version: 'test',
    createProvider: () => provider,
  })
  try {
    let began = false
    const completed = new Promise<void>((resolve) => {
      const unsubscribe = controller.subscribe((event) => {
        if (event.type === 'busy' && event.busy) began = true
        if (event.type === 'busy' && !event.busy && began) { unsubscribe(); resolve() }
      })
    })
    controller.submit('ubah implementasi')
    await modelStarted
    controller.submit('jangan buat file, cukup jelaskan')
    const during = controller.snapshot()
    assert.deepEqual(during.queue, [])
    assert.equal(during.items.filter((item) => item.kind === 'user' && item.steering).length, 1)
    release()
    await completed

    assert.ok(seen[1].some((message) => message.role === 'user' && message.content?.startsWith(USER_STEERING_MARK)))
    assert.equal(controller.snapshot().items.filter((item) => item.kind === 'user').length, 2)
    const answer = controller.snapshot().items.find((item) => item.kind === 'answer')
    assert.ok(answer?.kind === 'answer')
    assert.match(answer.markdown, /Arah baru/)
  } finally {
    controller.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
