/**
 * Adapter API Anthropic (Claude).
 *
 * Anthropic tidak memakai bentuk chat-completions: endpointnya `/v1/messages`,
 * kuncinya dikirim sebagai `x-api-key`, pesan system berdiri sendiri di luar daftar
 * pesan, pemanggilan tool berupa blok `tool_use`/`tool_result`, dan aliran SSE-nya
 * berupa kejadian bernama, bukan potongan `choices[0].delta`.
 *
 * Modul ini menerjemahkan dua arah sehingga sisa Boo — agent loop, izin, transkrip,
 * sesi — tidak perlu tahu penyedia mana yang sedang dipakai: masuk sebagai pesan
 * gaya OpenAI, keluar sebagai event yang sama dengan adapter lain.
 *
 * Kredensial langganan Claude Code tidak dipakai di sini; yang dipakai hanya kunci
 * API dari console Anthropic.
 */

import type { Message, ToolCall, ToolSchema } from '../domain/message.ts'
import { connectionError, httpError, ProviderError } from './errors.ts'
import type { ProviderProfile } from './profiles.ts'
import { quotaTracker } from './quota.ts'

/** Versi API yang kontraknya dipakai di sini. */
export const ANTHROPIC_VERSION = '2023-06-01'
/** Anthropic mewajibkan batas keluaran; nilai ini cukup untuk jawaban dan patch panjang. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 8_192

/** Tingkat penalaran diterjemahkan menjadi anggaran berpikir. */
const THINKING_BUDGET: Record<string, number> = {
  'extra-low': 1_024,
  low: 2_048,
  medium: 8_192,
  high: 16_384,
  xhigh: 32_768,
}

interface WireContent {
  type: string
  text?: string
  image_url?: { url: string }
}

/** Pesan gaya OpenAI yang sudah siap kirim, sebagaimana dibentuk adapter utama. */
export interface OutboundMessage {
  role: string
  content?: string | null | WireContent[]
  tool_calls?: ToolCall[]
  tool_call_id?: string
}

type Block =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string }

interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: Block[]
}

export interface AnthropicRequest {
  system: string
  messages: AnthropicMessage[]
}

function imageBlock(url: string): Block | null {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(url)
  if (!match) return null
  return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } }
}

function textBlocks(content: OutboundMessage['content']): Block[] {
  if (!content) return []
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : []
  const blocks: Block[] = []
  for (const part of content) {
    if (part.type === 'text' && part.text) blocks.push({ type: 'text', text: part.text })
    if (part.type === 'image_url' && part.image_url?.url) {
      const image = imageBlock(part.image_url.url)
      if (image) blocks.push(image)
    }
  }
  return blocks
}

/**
 * Menyusun permintaan Anthropic dari percakapan gaya OpenAI.
 *
 * Tiga hal yang wajib dipenuhi: pesan system terpisah, hasil tool dikirim sebagai
 * blok di pesan pengguna tepat setelah pemanggilnya, dan peran tidak boleh berulang
 * berturut-turut — pesan sejenis yang berdampingan digabungkan.
 */
export function toAnthropicRequest(messages: readonly OutboundMessage[]): AnthropicRequest {
  const system: string[] = []
  const converted: AnthropicMessage[] = []

  const push = (role: 'user' | 'assistant', blocks: Block[]) => {
    if (!blocks.length) return
    const last = converted.at(-1)
    if (last?.role === role) last.content.push(...blocks)
    else converted.push({ role, content: blocks })
  }

  for (const message of messages) {
    if (message.role === 'system') {
      const text = typeof message.content === 'string' ? message.content : textBlocks(message.content).map((block) => block.type === 'text' ? block.text : '').join('\n')
      if (text.trim()) system.push(text)
      continue
    }
    if (message.role === 'tool') {
      const content = typeof message.content === 'string' ? message.content : ''
      push('user', [{ type: 'tool_result', tool_use_id: message.tool_call_id ?? '', content: content || '(tanpa keluaran)' }])
      continue
    }
    if (message.role === 'assistant') {
      const blocks = textBlocks(message.content)
      for (const call of message.tool_calls ?? []) {
        let input: unknown
        try {
          input = JSON.parse(call.function.arguments || '{}')
        } catch {
          // Argumen rusak dikirim apa adanya agar model melihat kesalahannya sendiri.
          input = { arguments: call.function.arguments }
        }
        blocks.push({ type: 'tool_use', id: call.id, name: call.function.name, input })
      }
      push('assistant', blocks)
      continue
    }
    push('user', textBlocks(message.content))
  }

  // Percakapan harus dimulai dari pengguna.
  while (converted.length && converted[0].role !== 'user') converted.shift()
  return { system: system.join('\n\n'), messages: converted }
}

/** Skema tool gaya OpenAI menjadi bentuk Anthropic. */
export function toAnthropicTools(tools: readonly ToolSchema[]): { name: string; description: string; input_schema: unknown }[] {
  return tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters ?? { type: 'object', properties: {} },
  }))
}

function finishReasonOf(stop: string | null | undefined): string {
  switch (stop) {
    case 'tool_use': return 'tool_calls'
    case 'max_tokens': return 'length'
    case 'refusal': return 'content_filter'
    default: return 'stop'
  }
}

export interface AnthropicStreamOptions {
  profile: ProviderProfile
  model: string
  messages: readonly OutboundMessage[]
  tools: readonly ToolSchema[]
  reasoningEffort?: string
  maxOutputTokens?: number
  timeoutMs: number
  signal?: AbortSignal
}

/** Bentuknya sengaja sama persis dengan event adapter OpenAI. */
export type AnthropicStreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'tool-call'; index: number; name: string; delta: string }

export interface AnthropicResult {
  finishReason: string
  message: Message
}

/**
 * Mengirim percakapan dan menghasilkan event yang sama bentuknya dengan adapter
 * OpenAI, sehingga agent loop tidak membedakan penyedia.
 */
export async function* streamAnthropic(options: AnthropicStreamOptions): AsyncGenerator<AnthropicStreamEvent, AnthropicResult> {
  const { profile, model, tools, reasoningEffort, timeoutMs, signal } = options
  const base = profile.baseUrl.endsWith('/') ? profile.baseUrl : `${profile.baseUrl}/`
  const endpoint = new URL('v1/messages', base)
  const { system, messages } = toAnthropicRequest(options.messages)
  const budget = reasoningEffort ? THINKING_BUDGET[reasoningEffort] : undefined
  const maxTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS

  // Batas waktu dihitung sejak data terakhir, bukan sejak permintaan dimulai.
  const idle = new AbortController()
  let idleTimedOut = false
  let idleTimer: NodeJS.Timeout | undefined
  const touch = () => {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      idleTimedOut = true
      idle.abort()
    }, timeoutMs)
  }
  touch()
  const requestSignal = signal ? AbortSignal.any([signal, idle.signal]) : idle.signal

  let response: Response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'x-api-key': profile.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        model,
        max_tokens: budget ? budget + maxTokens : maxTokens,
        stream: true,
        ...(system ? { system } : {}),
        messages,
        ...(tools.length ? { tools: toAnthropicTools(tools) } : {}),
        ...(budget ? { thinking: { type: 'enabled', budget_tokens: budget } } : {}),
      }),
      signal: requestSignal,
    })
  } catch (error) {
    clearTimeout(idleTimer)
    if (signal?.aborted) throw error
    const failure = connectionError(error, idleTimedOut)
    quotaTracker.recordFailure(profile.id, model, failure.message)
    throw failure
  }

  if (!response.ok || !response.body) {
    let raw = ''
    try {
      raw = await response.text()
    } catch {
      // Badan respons ikut terputus; status saja sudah cukup.
    } finally {
      clearTimeout(idleTimer)
    }
    const failure = httpError(raw, response.status)
    quotaTracker.recordFailure(profile.id, model, failure.message, failure.retryAfterMs)
    throw failure
  }
  quotaTracker.recordRequest(profile.id, model, response.headers)

  const toolCalls = new Map<number, { id: string; name: string; args: string }>()
  let content = ''
  let reasoning = ''
  let finishReason = 'stop'
  let buffer = ''

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  try {
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>
      try {
        chunk = await reader.read()
      } catch (error) {
        if (signal?.aborted) throw error
        throw connectionError(error, idleTimedOut)
      }
      if (chunk.done) break
      touch()
      buffer += chunk.value

      let boundary = buffer.indexOf('\n')
      while (boundary !== -1) {
        const line = buffer.slice(0, boundary).trim()
        buffer = buffer.slice(boundary + 1)
        boundary = buffer.indexOf('\n')
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload) continue

        let event: {
          type?: string
          index?: number
          content_block?: { type?: string; id?: string; name?: string }
          delta?: { type?: string; text?: string; thinking?: string; partial_json?: string; stop_reason?: string }
          error?: { type?: string; message?: string }
        }
        try {
          event = JSON.parse(payload)
        } catch {
          continue
        }

        if (event.type === 'error') {
          throw httpError(JSON.stringify(event), event.error?.type === 'overloaded_error' ? 529 : event.error?.type === 'rate_limit_error' ? 429 : 400)
        }
        if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
          const index = event.index ?? toolCalls.size
          toolCalls.set(index, { id: event.content_block.id ?? `call_${index}`, name: event.content_block.name ?? '', args: '' })
          yield { type: 'tool-call', index, name: event.content_block.name ?? '', delta: '' }
          continue
        }
        if (event.type === 'content_block_delta') {
          const index = event.index ?? 0
          if (event.delta?.type === 'text_delta' && event.delta.text) {
            content += event.delta.text
            yield { type: 'text', delta: event.delta.text }
          } else if (event.delta?.type === 'thinking_delta' && event.delta.thinking) {
            reasoning += event.delta.thinking
            yield { type: 'reasoning', delta: event.delta.thinking }
          } else if (event.delta?.type === 'input_json_delta' && event.delta.partial_json !== undefined) {
            const call = toolCalls.get(index)
            if (call) {
              call.args += event.delta.partial_json
              yield { type: 'tool-call', index, name: call.name, delta: event.delta.partial_json }
            }
          }
          continue
        }
        if (event.type === 'message_delta' && event.delta?.stop_reason) {
          finishReason = finishReasonOf(event.delta.stop_reason)
        }
      }
    }
  } finally {
    clearTimeout(idleTimer)
    reader.releaseLock()
  }

  quotaTracker.recordTokens(
    profile.id,
    model,
    [system, ...messages.map((message) => JSON.stringify(message.content))].join('\n'),
    content + reasoning,
  )

  const calls: ToolCall[] = [...toolCalls.entries()]
    .sort(([a], [b]) => a - b)
    .filter(([, call]) => call.name)
    .map(([, call]) => ({ id: call.id, type: 'function' as const, function: { name: call.name, arguments: call.args || '{}' } }))
  if (calls.length && finishReason === 'stop') finishReason = 'tool_calls'

  return {
    finishReason,
    message: {
      role: 'assistant',
      content: content || null,
      ...(reasoning ? { reasoning_content: reasoning } : {}),
      ...(calls.length ? { tool_calls: calls } : {}),
    },
  }
}

/** Daftar model yang tersedia untuk kunci ini. */
export async function listAnthropicModels(profile: ProviderProfile, timeoutMs: number, signal?: AbortSignal): Promise<string[]> {
  const base = profile.baseUrl.endsWith('/') ? profile.baseUrl : `${profile.baseUrl}/`
  const response = await fetch(new URL('v1/models?limit=100', base), {
    headers: { 'x-api-key': profile.apiKey, 'anthropic-version': ANTHROPIC_VERSION, Accept: 'application/json' },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
  })
  const raw = await response.text()
  if (!response.ok) throw httpError(raw, response.status)
  try {
    const body = JSON.parse(raw) as { data?: { id?: string }[] }
    return (body.data ?? []).map((model) => model.id).filter((id): id is string => Boolean(id))
  } catch {
    throw new ProviderError('Daftar model Anthropic tidak dapat dibaca.', { retryable: false })
  }
}
