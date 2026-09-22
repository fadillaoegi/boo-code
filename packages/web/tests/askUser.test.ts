import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { Message } from '@boo/core'
import type { QuestionView } from '../src/protocol.ts'

const directory = mkdtempSync(join(tmpdir(), 'boo-web-question-'))
process.env.HOME = directory
const { NineRouterProvider } = await import('@boo/core')
const { WebController } = await import('../src/server/controller.ts')

test('web menampilkan pertanyaan agent dan meneruskan pilihan ke model', async () => {
  const provider = new NineRouterProvider({ baseUrl: 'http://unused.invalid', apiKey: 'fake', model: 'test-model' })
  let turn = 0
  const toolResults: string[] = []
  provider.stream = async function* (messages: Message[]) {
    turn += 1
    if (turn === 1) {
      return {
        finishReason: 'tool_calls',
        message: {
          role: 'assistant' as const,
          content: null,
          tool_calls: [{
            id: 'ask-web',
            type: 'function' as const,
            function: {
              name: 'ask_user',
              arguments: JSON.stringify({
                questions: [{
                  header: 'API',
                  question: 'Format respons mana yang dipakai?',
                  options: [
                    { label: 'Tetap', description: 'Pertahankan kompatibilitas.' },
                    { label: 'Versi baru', description: 'Gunakan kontrak yang lebih bersih.' },
                  ],
                  allow_custom: true,
                }],
              }),
            },
          }],
        },
      }
    }
    toolResults.push(messages.findLast((message) => message.role === 'tool')?.content ?? '')
    const content = 'Baik, saya gunakan format yang dipilih.'
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
    let resolveQuestion!: (question: QuestionView) => void
    const question = new Promise<QuestionView>((resolve) => { resolveQuestion = resolve })
    let started = false
    let resolveDone!: () => void
    const done = new Promise<void>((resolve) => { resolveDone = resolve })
    const unsubscribe = controller.subscribe((event) => {
      if (event.type === 'question' && event.question) resolveQuestion(event.question)
      if (event.type === 'busy' && event.busy) started = true
      if (event.type === 'busy' && !event.busy && started) resolveDone()
    })

    controller.submit('ubah kontrak API')
    const shown = await question
    assert.equal(shown.title, 'API')
    assert.match(shown.options[0].label, /Pertahankan kompatibilitas/)
    assert.equal(shown.options.at(-1)?.id, 'custom')
    assert.equal(controller.answer(shown.id, 'choice-1'), true)
    await done
    unsubscribe()

    assert.match(toolResults[0], /API: Versi baru/)
    const decision = controller.snapshot().items.find((item) => item.kind === 'decision')
    assert.equal(decision?.kind === 'decision' ? decision.text : '', 'Jawaban · API: Versi baru')
  } finally {
    controller.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
