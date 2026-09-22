import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Agent } from '../src/agent/loop.ts'
import type { Message } from '../src/domain/message.ts'
import type { NineRouterProvider } from '../src/provider/nineRouter.ts'
import { buildTranscript } from '../src/presentation/transcript.ts'
import { askUserTool, parseUserQuestions, userAnswerSummary } from '../src/tools/askUser.ts'
import { createDefaultRegistry } from '../src/tools/index.ts'

const rawQuestions = [{
  header: 'Database',
  question: 'Penyimpanan mana yang harus dipakai?',
  options: [
    { label: 'SQLite', description: 'Sederhana untuk satu proses.' },
    { label: 'PostgreSQL', description: 'Cocok untuk deployment terdistribusi.' },
  ],
  allow_custom: true,
}]

test('ask_user memvalidasi pertanyaan dan meneruskan pilihan sebagai hasil tool', async () => {
  assert.equal(typeof parseUserQuestions(rawQuestions), 'object')
  assert.match(String(parseUserQuestions([])), /1-10/)
  const ten = Array.from({ length: 10 }, (_, index) => ({
    question: `Keputusan ${index + 1}?`,
    options: [{ label: 'Ya' }, { label: 'Tidak' }],
  }))
  assert.equal(Array.isArray(parseUserQuestions(ten)), true)
  assert.match(String(parseUserQuestions([...ten, ten[0]])), /1-10/)
  assert.match(String(parseUserQuestions([{ ...rawQuestions[0], options: [{ label: 'Sama' }, { label: 'sama' }] }])), /lebih dari sekali/)

  const result = await askUserTool.run({ questions: rawQuestions }, {
    workspace: '/unused',
    askUser: async (question) => {
      assert.equal(question.options[1].description, 'Cocok untuk deployment terdistribusi.')
      return { selected: 'PostgreSQL' }
    },
  })
  assert.equal(result.isError, undefined)
  assert.match(result.content, /Database: PostgreSQL/)
  assert.equal(userAnswerSummary(result.content), 'Database: PostgreSQL')
})

test('ask_user menerima jawaban bebas hanya bila diizinkan dan gagal tanpa UI', async () => {
  const custom = await askUserTool.run({ questions: rawQuestions }, {
    workspace: '/unused',
    askUser: async () => ({ text: 'Gunakan service yang sudah ada' }),
  })
  assert.match(custom.content, /Gunakan service yang sudah ada/)

  const unavailable = await askUserTool.run({ questions: rawQuestions }, { workspace: '/unused' })
  assert.equal(unavailable.isError, true)
  assert.match(unavailable.content, /tidak mendukung/)
})

test('agent menunggu jawaban lalu memberi hasilnya kembali ke model dan history', async () => {
  const seen: Message[][] = []
  let turn = 0
  const provider = {
    model: 'question-model',
    // eslint-disable-next-line require-yield
    async *stream(messages: Message[]) {
      seen.push(messages.map((message) => ({ ...message })))
      turn += 1
      if (turn === 1) return {
        finishReason: 'tool_calls',
        message: {
          role: 'assistant' as const,
          content: null,
          tool_calls: [{
            id: 'ask-1',
            type: 'function' as const,
            function: { name: 'ask_user', arguments: JSON.stringify({ questions: rawQuestions }) },
          }],
        },
      }
      const answer = messages.findLast((message) => message.role === 'tool')?.content ?? ''
      return { finishReason: 'stop', message: { role: 'assistant' as const, content: `Dipilih: ${answer}` } }
    },
  } as unknown as NineRouterProvider
  const answers: string[] = []
  const agent = new Agent({
    provider,
    registry: createDefaultRegistry(),
    workspace: mkdtempSync(join(tmpdir(), 'boo-ask-user-')),
    askPermission: async () => true,
    askUser: async (question) => {
      answers.push(question.question)
      return { selected: 'SQLite' }
    },
    verifyCompletion: false,
  })

  for await (const event of agent.send('buat penyimpanan')) void event
  assert.deepEqual(answers, ['Penyimpanan mana yang harus dipakai?'])
  assert.match(seen[1].find((message) => message.role === 'tool')?.content ?? '', /Database: SQLite/)
  assert.match(agent.history.at(-1)?.content ?? '', /Database: SQLite/)
  const decision = buildTranscript(agent.history).flat().find((item) => item.kind === 'decision')
  assert.equal(decision?.kind === 'decision' ? decision.text : '', 'Jawaban · Database: SQLite')
})
