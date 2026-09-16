/**
 * Adapter 9Router.
 *
 * Perilaku yang dikodekan di sini berasal dari pengujian nyata terhadap
 * instance 9Router (lihat `pnpm check:tools` di repo boo-ai-chat-web):
 * - `stream` selalu dikirim eksplisit karena provider ag/* default-nya
 *   streaming, sehingga request tanpa field itu membalas SSE.
 * - `reasoning_content` dipisahkan dari `content` supaya balasan model
 *   thinking tidak dikira kosong.
 * - Potongan `tool_calls` pada SSE disambung berdasarkan `index`, karena
 *   `arguments` datang terpecah antar chunk.
 */

import type { Message, ToolCall, ToolSchema } from '../domain/message.ts'

export interface ProviderOptions {
  baseUrl: string
  apiKey: string
  model: string
  timeoutMs?: number
}

export type StreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }

export interface CompletionResult {
  message: Message
  /** Alasan model berhenti; `tool_calls` berarti ia menunggu hasil tool. */
  finishReason: string
}

const DEFAULT_TIMEOUT_MS = 120_000

interface DeltaToolCall {
  index?: number
  id?: string
  function?: { name?: string; arguments?: string }
}

/** Menyambung potongan tool_calls dari beberapa chunk SSE menjadi utuh. */
class ToolCallAccumulator {
  private readonly byIndex = new Map<number, { id: string; name: string; args: string }>()

  add(delta: DeltaToolCall): void {
    const index = delta.index ?? 0
    const current = this.byIndex.get(index) ?? { id: '', name: '', args: '' }
    if (delta.id) current.id = delta.id
    if (delta.function?.name) current.name = delta.function.name
    if (delta.function?.arguments) current.args += delta.function.arguments
    this.byIndex.set(index, current)
  }

  toToolCalls(): ToolCall[] {
    return [...this.byIndex.entries()]
      .sort(([a], [b]) => a - b)
      .filter(([, call]) => call.name)
      .map(([, call]) => ({
        id: call.id,
        type: 'function' as const,
        function: { name: call.name, arguments: call.args || '{}' },
      }))
  }
}

function errorMessage(rawBody: string, status: number): string {
  try {
    const parsed = JSON.parse(rawBody) as { error?: { message?: string } }
    return parsed.error?.message || `9Router merespons HTTP ${status}.`
  } catch {
    return `9Router merespons HTTP ${status}.`
  }
}

export class NineRouterProvider {
  private readonly options: ProviderOptions

  constructor(options: ProviderOptions) {
    this.options = options
  }

  get model(): string {
    return this.options.model
  }

  /**
   * Mengirim percakapan dan menghasilkan event teks selama streaming.
   * Nilai kembaliannya adalah pesan assistant yang sudah utuh, siap
   * dimasukkan kembali ke riwayat percakapan.
   */
  async *stream(
    messages: Message[],
    tools: ToolSchema[],
  ): AsyncGenerator<StreamEvent, CompletionResult> {
    const { baseUrl, apiKey, model, timeoutMs = DEFAULT_TIMEOUT_MS } = this.options
    const endpoint = new URL('v1/chat/completions', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`)

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })

    if (!response.ok || !response.body) {
      throw new Error(errorMessage(await response.text(), response.status))
    }

    const accumulator = new ToolCallAccumulator()
    let content = ''
    let reasoning = ''
    let finishReason = 'stop'
    let buffer = ''

    const decoder = new TextDecoderStream()
    const reader = response.body.pipeThrough(decoder).getReader()

    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += value

        // Satu event SSE berakhir pada baris kosong; sisanya menunggu chunk berikutnya.
        let boundary = buffer.indexOf('\n')
        while (boundary !== -1) {
          const line = buffer.slice(0, boundary).trim()
          buffer = buffer.slice(boundary + 1)
          boundary = buffer.indexOf('\n')

          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (!payload || payload === '[DONE]') continue

          let parsed
          try {
            parsed = JSON.parse(payload)
          } catch {
            continue
          }

          const choice = parsed.choices?.[0]
          if (!choice) continue
          if (choice.finish_reason) finishReason = choice.finish_reason

          const delta = choice.delta
          if (delta?.reasoning_content) {
            reasoning += delta.reasoning_content
            yield { type: 'reasoning', delta: delta.reasoning_content }
          }
          if (delta?.content) {
            content += delta.content
            yield { type: 'text', delta: delta.content }
          }
          for (const call of delta?.tool_calls ?? []) accumulator.add(call)
        }
      }
    } finally {
      reader.releaseLock()
    }

    const toolCalls = accumulator.toToolCalls()
    if (toolCalls.length && finishReason === 'stop') finishReason = 'tool_calls'

    return {
      finishReason,
      message: {
        role: 'assistant',
        content: content || null,
        ...(reasoning ? { reasoning_content: reasoning } : {}),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      },
    }
  }
}
