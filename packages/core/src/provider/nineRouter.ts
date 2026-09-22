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

import { homedir } from 'node:os'
import { imageDataUrl } from '../agent/attachments.ts'
import type { Message, ToolCall, ToolSchema } from '../domain/message.ts'
import { redactOutboundMessages } from '../security/redaction.ts'
import { listAnthropicModels, streamAnthropic } from './anthropic.ts'
import { connectionError, errorMessage, httpError, ProviderError } from './errors.ts'
import { defaultProfile, splitModelId, qualifyModelId, type ProviderProfile } from './profiles.ts'

export { connectionError, httpError, ProviderError } from './errors.ts'

export interface ProviderOptions {
  baseUrl: string
  apiKey: string
  /** Dapat diubah saat sesi berjalan lewat perintah /model. */
  model: string
  /**
   * Dikirim sebagai `reasoning_effort` untuk model yang menerimanya, misalnya
   * Codex. Model yang menanam tingkatnya di nama tidak memerlukan ini.
   */
  reasoningEffort?: string
  timeoutMs?: number
  /**
   * Penyedia yang tersedia. Yang pertama melayani model tanpa awalan; sisanya
   * dipilih lewat awalan id model seperti `anthropic:`. Tanpa daftar ini, Boo
   * memakai `baseUrl` dan `apiKey` di atas sebagai satu-satunya penyedia.
   */
  profiles?: ProviderProfile[]
  /** Batas token keluaran untuk penyedia yang mewajibkannya, seperti Anthropic. */
  maxOutputTokens?: number
  /** Root penyimpanan attachment; terutama diganti pada test. */
  home?: string
}

export type StreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  /**
   * Potongan argumen pemanggilan tool yang sedang digenerate model. Untuk tool
   * seperti write_file, argumen ini adalah isi berkas itu sendiri dan dapat
   * mengalir lama sebelum tool dijalankan — tanpa kejadian ini, momen tersebut
   * tidak terlihat sama sekali.
   */
  | { type: 'tool-call'; index: number; name: string; delta: string }

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

  nameOf(index: number): string {
    return this.byIndex.get(index)?.name ?? ''
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

type WireMessage = Omit<Message, 'content' | 'images'> & {
  content?: string | null | Array<
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string; detail: 'auto' } }
  >
}

/** Referensi file privat hanya dibaca sesaat sebelum request dan tidak dikirim sebagai path. */
function wireMessages(messages: readonly Message[], home: string, apiKey: string): WireMessage[] {
  const outbound = redactOutboundMessages(messages, { secrets: [apiKey], environment: process.env }).messages
  return outbound.map(({ images, ...message }) => {
    if (!images?.length) return message
    if (message.role !== 'user') throw new ProviderError('Attachment gambar hanya boleh berada pada pesan pengguna.', { retryable: false })
    return {
      ...message,
      content: [
        ...(message.content ? [{ type: 'text' as const, text: message.content }] : []),
        ...images.map((image) => ({ type: 'image_url' as const, image_url: { url: imageDataUrl(image, home), detail: 'auto' as const } })),
      ],
    }
  })
}

export class NineRouterProvider {
  private readonly options: ProviderOptions

  constructor(options: ProviderOptions) {
    this.options = options
  }

  get model(): string {
    return this.options.model
  }

  /** Model dapat diganti di tengah sesi tanpa kehilangan riwayat percakapan. */
  set model(model: string) {
    this.options.model = model
  }

  get reasoningEffort(): string | undefined {
    return this.options.reasoningEffort
  }

  set reasoningEffort(effort: string | undefined) {
    this.options.reasoningEffort = effort
  }

  /** Penyedia yang dikonfigurasi; bawaannya satu penyedia dari baseUrl dan apiKey. */
  get profiles(): ProviderProfile[] {
    const configured = this.options.profiles
    if (configured?.length) return configured
    return [{ id: 'ninerouter', label: '9Router', baseUrl: this.options.baseUrl, apiKey: this.options.apiKey, wire: 'openai' }]
  }

  /** Memecah id model menjadi penyedia dan nama model di sisi penyedia itu. */
  private resolve(modelId: string): { profile: ProviderProfile; model: string } {
    const { providerId, model } = splitModelId(modelId)
    const profiles = this.profiles
    const profile = providerId ? profiles.find((candidate) => candidate.id === providerId) : defaultProfile(profiles)
    if (!profile) {
      throw new ProviderError(
        providerId
          ? `Penyedia "${providerId}" belum dikonfigurasi. Jalankan: boo-code setup`
          : 'Belum ada penyedia model yang dikonfigurasi. Jalankan: boo-code setup',
        { retryable: false },
      )
    }
    return { profile, model }
  }

  /** Provider penilai memakai koneksi yang sama tanpa mengganti model agent. */
  fork(model: string, reasoningEffort?: string): NineRouterProvider {
    return new NineRouterProvider({ ...this.options, model, reasoningEffort, timeoutMs: 12_000 })
  }

  /**
   * Daftar model dari seluruh penyedia yang dikonfigurasi. Model penyedia utama
   * tampil polos; sisanya diberi awalan penyedia. Penyedia yang sedang bermasalah
   * dilewati agar satu kunci yang kedaluwarsa tidak menutup seluruh daftar.
   */
  async listModels(signal?: AbortSignal): Promise<string[]> {
    const { timeoutMs = DEFAULT_TIMEOUT_MS } = this.options
    const profiles = this.profiles
    const primary = defaultProfile(profiles)
    const lists = await Promise.all(profiles.map(async (profile) => {
      try {
        const ids = profile.wire === 'anthropic'
          ? await listAnthropicModels(profile, timeoutMs, signal)
          : await listOpenAiModels(profile, timeoutMs, signal)
        return ids.map((id) => profile === primary ? id : qualifyModelId(profile.id, id))
      } catch (error) {
        if (profiles.length === 1) throw error
        return []
      }
    }))
    return lists.flat()
  }

  /**
   * Mengirim percakapan dan menghasilkan event teks selama streaming.
   * Nilai kembaliannya adalah pesan assistant yang sudah utuh, siap
   * dimasukkan kembali ke riwayat percakapan.
   */
  async *stream(
    messages: Message[],
    tools: ToolSchema[],
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent, CompletionResult> {
    const { model: requestedModel, reasoningEffort, timeoutMs = DEFAULT_TIMEOUT_MS } = this.options
    const { profile, model } = this.resolve(requestedModel)
    const { baseUrl, apiKey } = profile
    const endpoint = new URL('v1/chat/completions', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`)
    let outboundMessages: WireMessage[]
    try { outboundMessages = wireMessages(messages, this.options.home ?? homedir(), apiKey) } catch (error) {
      if (error instanceof ProviderError) throw error
      throw new ProviderError(error instanceof Error ? error.message : 'Attachment gambar tidak dapat dibaca.', { retryable: false })
    }

    if (profile.wire === 'anthropic') {
      return yield* streamAnthropic({
        profile,
        model,
        messages: outboundMessages,
        tools,
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(this.options.maxOutputTokens ? { maxOutputTokens: this.options.maxOutputTokens } : {}),
        timeoutMs,
        ...(signal ? { signal } : {}),
      })
    }

    // Batas waktu dihitung sejak data terakhir, bukan sejak permintaan dimulai:
    // jawaban panjang yang terus mengalir tidak boleh diputus di tengah jalan.
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
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({
          model,
          messages: outboundMessages,
          stream: true,
          ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
          ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
        }),
        // Pembatalan pengguna memutus koneksi seketika.
        signal: requestSignal,
      })
    } catch (error) {
      clearTimeout(idleTimer)
      if (signal?.aborted) throw error
      throw connectionError(error, idleTimedOut)
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
      throw httpError(raw, response.status)
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
        let chunk: Awaited<ReturnType<typeof reader.read>>
        try {
          chunk = await reader.read()
        } catch (error) {
          if (signal?.aborted) throw error
          throw connectionError(error, idleTimedOut)
        }
        const { done, value } = chunk
        if (done) break
        touch()
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

          // Error dari provider dapat datang di tengah aliran, setelah HTTP 200.
          if (parsed.error) throw httpError(payload, 200)

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
          for (const call of delta?.tool_calls ?? []) {
            accumulator.add(call)
            // Nama tool bisa datang lebih dulu dari argumennya; kejadian baru dikirim
            // setelah nama diketahui, supaya penerima tahu apa yang sedang digenerate.
            const name = accumulator.nameOf(call.index ?? 0)
            if (name) yield { type: 'tool-call', index: call.index ?? 0, name, delta: call.function?.arguments ?? '' }
          }
        }
      }
    } finally {
      clearTimeout(idleTimer)
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

/** Daftar model dari penyedia berbentuk OpenAI. */
async function listOpenAiModels(profile: ProviderProfile, timeoutMs: number, signal?: AbortSignal): Promise<string[]> {
  const base = profile.baseUrl.endsWith('/') ? profile.baseUrl : `${profile.baseUrl}/`
  const response = await fetch(new URL('v1/models', base), {
    headers: { ...(profile.apiKey ? { Authorization: `Bearer ${profile.apiKey}` } : {}), Accept: 'application/json' },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
  })
  const raw = await response.text()
  if (!response.ok) throw new Error(errorMessage(raw, response.status))
  const body = JSON.parse(raw) as { data?: { id?: string }[] }
  return (body.data ?? []).map((model) => model.id).filter((id): id is string => Boolean(id))
}
