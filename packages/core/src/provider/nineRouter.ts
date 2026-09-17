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
  /** Dapat diubah saat sesi berjalan lewat perintah /model. */
  model: string
  /**
   * Dikirim sebagai `reasoning_effort` untuk model yang menerimanya, misalnya
   * Codex. Model yang menanam tingkatnya di nama tidak memerlukan ini.
   */
  reasoningEffort?: string
  timeoutMs?: number
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

function errorMessage(rawBody: string, status: number): string {
  try {
    const parsed = JSON.parse(rawBody) as { error?: { message?: string } }
    return parsed.error?.message || `9Router merespons HTTP ${status}.`
  } catch {
    return `9Router merespons HTTP ${status}.`
  }
}

/** Status yang biasanya pulih sendiri: limit, dan gangguan di sisi server. */
const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504, 529])
/** Jeda dari 9Router lebih lama dari ini tidak ditunggu otomatis. */
const MAX_RETRY_AFTER_MS = 60_000

/**
 * Kegagalan memanggil model, beserta apakah layak diulang.
 *
 * 9Router membungkus error provider di pesannya — `[codex/gpt-5.6] [429]: …` —
 * dan menambahkan `(reset after 20s)` pada error apa pun, termasuk permintaan
 * yang memang salah. Karena itu keputusan mengulang diambil dari status, bukan
 * dari ada-tidaknya jeda: permintaan 400 yang diulang hanya gagal lagi.
 */
export class ProviderError extends Error {
  readonly status: number | undefined
  readonly retryable: boolean
  /** Jeda yang diminta 9Router sebelum model ini dapat dipakai lagi. */
  readonly retryAfterMs: number | undefined

  constructor(message: string, options: { status?: number; retryable: boolean; retryAfterMs?: number }) {
    super(message)
    this.name = 'ProviderError'
    this.status = options.status
    this.retryable = options.retryable
    this.retryAfterMs = options.retryAfterMs
  }
}

/** Mengklasifikasikan respons HTTP yang gagal. */
export function httpError(rawBody: string, status: number): ProviderError {
  const message = errorMessage(rawBody, status)
  // Status provider di dalam pesan lebih jujur daripada status HTTP 9Router sendiri.
  const inner = /\[(\d{3})\]:/.exec(message)
  const effective = inner ? Number(inner[1]) : status
  const reset = /reset after (\d+)\s*s/i.exec(message)
  const retryAfterMs = reset ? Number(reset[1]) * 1_000 : undefined
  const retryable = TRANSIENT_STATUS.has(effective) && (retryAfterMs === undefined || retryAfterMs <= MAX_RETRY_AFTER_MS)
  return new ProviderError(message, { status: effective, retryable, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) })
}

/** Koneksi putus atau tidak ada data sama sekali selama batas waktu: layak diulang. */
function connectionError(error: unknown, idle: boolean): ProviderError {
  if (idle) return new ProviderError('9Router tidak mengirim data apa pun terlalu lama.', { retryable: true })
  const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : ''
  const detail = error instanceof Error ? error.message : 'error tak dikenal'
  return new ProviderError(`Koneksi ke 9Router gagal (${detail}${cause}).`, { retryable: true })
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

  /** Daftar model yang tersedia di instance 9Router. */
  async listModels(): Promise<string[]> {
    const { baseUrl, apiKey, timeoutMs = DEFAULT_TIMEOUT_MS } = this.options
    const endpoint = new URL('v1/models', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`)
    const response = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    const raw = await response.text()
    if (!response.ok) throw new Error(errorMessage(raw, response.status))
    const body = JSON.parse(raw) as { data?: Array<{ id?: string }> }
    return (body.data ?? []).map((model) => model.id).filter((id): id is string => Boolean(id))
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
    const { baseUrl, apiKey, model, reasoningEffort, timeoutMs = DEFAULT_TIMEOUT_MS } = this.options
    const endpoint = new URL('v1/chat/completions', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`)

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
          messages,
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
