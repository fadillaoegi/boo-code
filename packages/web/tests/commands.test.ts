import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { Message } from '@boo/core'

const directory = mkdtempSync(join(tmpdir(), 'boo-web-command-'))
process.env.HOME = directory
const { NineRouterProvider, PROMPT_COMMAND_MARK } = await import('@boo/core')
const { WebController } = await import('../src/server/controller.ts')

test('web menemukan custom command, memperluas argumen, dan menampilkan command asli', async () => {
  const commands = join(directory, '.boo', 'commands')
  mkdirSync(commands, { recursive: true })
  writeFileSync(join(commands, 'review-api.md'), '---\ndescription: Review kontrak API\n---\nReview endpoint berikut: $ARGUMENTS')
  const provider = new NineRouterProvider({ baseUrl: 'http://unused.invalid', apiKey: 'fake', model: 'test-model' })
  const prompts: string[] = []
  provider.stream = async function* (messages: Message[]) {
    prompts.push(messages.filter((message) => message.role === 'user').at(-1)?.content ?? '')
    const content = 'Review selesai.'
    yield { type: 'text', delta: content }
    return { finishReason: 'stop', message: { role: 'assistant', content } }
  }
  const controller = new WebController({
    workspace: directory,
    home: directory,
    config: { BOO_MODEL: 'test-model' },
    version: 'test',
    createProvider: () => provider,
  })

  try {
    assert.deepEqual(controller.snapshot().commands, [{ name: 'review-api', description: 'Review kontrak API', source: 'project' }])
    let started = false
    let resolveDone!: () => void
    const done = new Promise<void>((resolve) => { resolveDone = resolve })
    const unsubscribe = controller.subscribe((event) => {
      if (event.type === 'busy' && event.busy) started = true
      if (event.type === 'busy' && !event.busy && started) resolveDone()
    })
    controller.submit('/review-api users')
    await done
    unsubscribe()

    assert.ok(prompts[0].startsWith(PROMPT_COMMAND_MARK))
    assert.match(prompts[0], /Review endpoint berikut: users/)
    assert.equal(controller.snapshot().items.find((item) => item.kind === 'user')?.text, '/review-api users')
  } finally {
    controller.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
