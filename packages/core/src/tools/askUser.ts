/** Pertanyaan terstruktur untuk keputusan yang tidak dapat disimpulkan dari repo. */

import type { Tool, UserAnswer, UserQuestion } from '../domain/tool.ts'

interface Args { questions: unknown }

export const MAX_USER_QUESTIONS = 10
export const USER_ANSWER_MARK = 'Jawaban pengguna:'

const DESCRIPTION = `Ask the user one to ten short, consequential questions before proceeding.
Use this only when repository evidence cannot resolve a decision that materially changes the implementation. Do not ask about facts you can inspect, trivial preferences, approval for a tool action, or whether to continue. Offer 2-4 mutually exclusive options and briefly explain each impact. Set allow_custom only when the choices are not exhaustive.`

function shortText(value: unknown, name: string, max: number, required = true): string | Error {
  if (typeof value !== 'string') return new Error(`${name} harus berupa teks.`)
  const text = value.trim().replace(/\s+/g, ' ')
  if (required && !text) return new Error(`${name} tidak boleh kosong.`)
  if (text.length > max) return new Error(`${name} maksimal ${max} karakter.`)
  return text
}

/** Validasi ketat mencegah kartu pertanyaan raksasa atau opsi ambigu. */
export function parseUserQuestions(raw: unknown): UserQuestion[] | string {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_USER_QUESTIONS) {
    return `questions harus berisi 1-${MAX_USER_QUESTIONS} pertanyaan.`
  }
  const questions: UserQuestion[] = []
  for (const [questionIndex, entry] of raw.entries()) {
    if (!entry || typeof entry !== 'object') return `questions[${questionIndex}] tidak valid.`
    const value = entry as { header?: unknown; question?: unknown; options?: unknown; allow_custom?: unknown }
    const question = shortText(value.question, `questions[${questionIndex}].question`, 500)
    if (question instanceof Error) return question.message
    const header = value.header === undefined ? '' : shortText(value.header, `questions[${questionIndex}].header`, 40, false)
    if (header instanceof Error) return header.message
    if (!Array.isArray(value.options) || value.options.length < 2 || value.options.length > 4) {
      return `questions[${questionIndex}].options harus berisi 2-4 pilihan.`
    }
    const options = []
    const labels = new Set<string>()
    for (const [optionIndex, optionEntry] of value.options.entries()) {
      if (!optionEntry || typeof optionEntry !== 'object') return `questions[${questionIndex}].options[${optionIndex}] tidak valid.`
      const option = optionEntry as { label?: unknown; description?: unknown }
      const label = shortText(option.label, `questions[${questionIndex}].options[${optionIndex}].label`, 80)
      if (label instanceof Error) return label.message
      const key = label.toLocaleLowerCase()
      if (labels.has(key)) return `Pilihan "${label}" muncul lebih dari sekali.`
      labels.add(key)
      const description = option.description === undefined
        ? ''
        : shortText(option.description, `questions[${questionIndex}].options[${optionIndex}].description`, 240, false)
      if (description instanceof Error) return description.message
      options.push({ label, ...(description ? { description } : {}) })
    }
    if (value.allow_custom !== undefined && typeof value.allow_custom !== 'boolean') {
      return `questions[${questionIndex}].allow_custom harus boolean.`
    }
    questions.push({
      ...(header ? { header } : {}),
      question,
      options,
      allowCustom: value.allow_custom === true,
    })
  }
  return questions
}

function normalizedAnswer(answer: UserAnswer, question: UserQuestion): { summary: string } | string {
  if (answer.cancelled) return 'Pertanyaan dibatalkan pengguna.'
  if (answer.selected) {
    const option = question.options.find((candidate) => candidate.label === answer.selected)
    if (!option) return 'Antarmuka mengembalikan pilihan yang tidak dikenal.'
    return { summary: option.label }
  }
  const text = answer.text?.trim().replace(/\s+/g, ' ')
  if (question.allowCustom && text) return { summary: text.slice(0, 2_000) }
  return 'Pengguna tidak memberikan jawaban yang valid.'
}

/** Ringkasan jawaban untuk transcript saat sesi dibuka kembali. */
export function userAnswerSummary(content: string): string | null {
  if (!content.startsWith(`${USER_ANSWER_MARK}\n`)) return null
  return content.slice(USER_ANSWER_MARK.length + 1).split('\n').map((line) => line.replace(/^- /, '').trim()).filter(Boolean).join('; ') || null
}

export const askUserTool: Tool<Args> = {
  name: 'ask_user',
  description: DESCRIPTION,
  risk: 'safe',
  schema: {
    type: 'function',
    function: {
      name: 'ask_user',
      description: DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_USER_QUESTIONS,
            items: {
              type: 'object',
              properties: {
                header: { type: 'string', description: 'Short topic label, at most 40 characters' },
                question: { type: 'string', description: 'One concrete decision question' },
                options: {
                  type: 'array',
                  minItems: 2,
                  maxItems: 4,
                  items: {
                    type: 'object',
                    properties: {
                      label: { type: 'string', description: 'Short mutually exclusive choice' },
                      description: { type: 'string', description: 'One sentence explaining impact or tradeoff' },
                    },
                    required: ['label'],
                  },
                },
                allow_custom: { type: 'boolean', description: 'Allow an answer outside these options' },
              },
              required: ['question', 'options'],
            },
          },
        },
        required: ['questions'],
      },
    },
  },
  preview: (args) => `tanyakan pengguna (${Array.isArray(args.questions) ? args.questions.length : 0})`,
  async run(args, context) {
    const questions = parseUserQuestions(args.questions)
    if (typeof questions === 'string') return { content: `Gagal: ${questions}`, isError: true }
    if (!context.askUser) return { content: 'Gagal: antarmuka ini tidak mendukung pertanyaan pengguna.', isError: true }

    const summaries: string[] = []
    for (const [index, question] of questions.entries()) {
      if (context.signal?.aborted) return { content: 'Pertanyaan dibatalkan.', isError: true }
      const answer = normalizedAnswer(await context.askUser(question), question)
      if (typeof answer === 'string') {
        const partial = summaries.length ? `${USER_ANSWER_MARK}\n${summaries.map((item) => `- ${item}`).join('\n')}\n` : ''
        return { content: `${partial}Gagal: ${answer} Jangan menebak keputusan penting.`, isError: true }
      }
      const label = question.header || `Pertanyaan ${index + 1}`
      summaries.push(`${label}: ${answer.summary}`)
    }
    return { content: `${USER_ANSWER_MARK}\n${summaries.map((item) => `- ${item}`).join('\n')}` }
  },
}
