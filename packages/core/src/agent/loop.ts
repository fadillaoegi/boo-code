/**
 * Agent loop: kirim percakapan, jalankan tool yang diminta, ulangi sampai model
 * berhenti meminta tool. Lapisan ini tidak tahu apa pun soal terminal maupun
 * browser — seluruh keluarannya berupa event, dan izin dimintakan lewat
 * callback. Itulah yang membuatnya bisa dipakai ulang oleh CLI dan web nanti.
 */

import type { Message } from '../domain/message.ts'
import type { DiffLine } from '../tools/diff.ts'
import type { ToolRegistry } from '../domain/tool.ts'
import { ProviderError, type NineRouterProvider } from '../provider/nineRouter.ts'
import { DEFAULT_MAX_CONTEXT_TOKENS, trimToBudget } from './context.ts'
import { repairHistory, type RepairResult } from './history.ts'
import { composeSystemPrompt, instructionsSignature, type InstructionFile } from './instructions.ts'
import { BOO_SYSTEM_PROMPT } from './prompt.ts'

export type AgentEvent =
  /**
   * Model dipanggil. Putaran 0 adalah jawaban awal atas permintaan pengguna;
   * putaran berikutnya adalah keputusan model setelah menerima hasil tool.
   */
  | { type: 'turn-start'; turn: number }
  | { type: 'reasoning'; delta: string }
  | { type: 'text'; delta: string }
  | { type: 'tool-call'; index: number; name: string; delta: string }
  | { type: 'tool-start'; name: string; preview: string; callId: string; args: Record<string, unknown> }
  /** Keluaran yang mengalir selagi tool berjalan, misalnya dari perintah bash. */
  | { type: 'tool-output'; name: string; callId: string; chunk: string }
  | { type: 'tool-end'; name: string; callId: string; content: string; isError: boolean; cancelled: boolean }
  | { type: 'tool-denied'; name: string; callId: string; feedback?: string }
  | { type: 'turn-end'; message: Message }
  | { type: 'context-trimmed'; droppedMessages: number; estimatedTokens: number }
  /** Pengguna menghentikan pekerjaan; riwayat sudah dirapikan dan tetap sah. */
  | { type: 'cancelled' }
  /** Berkas aturan proyek berubah sejak permintaan sebelumnya dan sudah dimuat ulang. */
  | { type: 'instructions-reloaded'; files: InstructionFile[] }
  /** Panggilan model gagal sementara dan akan diulang setelah jeda. */
  | { type: 'retry'; attempt: number; maxAttempts: number; delayMs: number; message: string }
  /** Batas langkah tercapai dan pengguna memilih berhenti. */
  | { type: 'turn-limit'; turns: number }
  | { type: 'error'; message: string }

/** Ditanyakan sebelum tool berisiko dijalankan. */
/**
 * Keputusan izin. `feedback` diisi bila pengguna menolak sambil memberi arahan;
 * arahan itu diteruskan ke model sebagai hasil tool, supaya penolakan menjadi
 * petunjuk langkah berikutnya, bukan jalan buntu.
 */
export interface PermissionDecision {
  allowed: boolean
  feedback?: string
}

export type PermissionAsker = (request: {
  name: string
  preview: string
  args: Record<string, unknown>
  /** Diff perubahan bila tool menyediakannya; null berarti tak ada yang berubah. */
  detail: DiffLine[] | null
}) => Promise<boolean | PermissionDecision>

export interface AgentOptions {
  provider: NineRouterProvider
  registry: ToolRegistry
  workspace: string
  askPermission: PermissionAsker
  /**
   * Jumlah putaran sebelum pengguna ditanya apakah pekerjaan dilanjutkan, agar
   * model yang tersesat tidak berputar selamanya tanpa sepengetahuan pengguna.
   */
  maxTurns?: number
  /**
   * Ditanyakan setiap kali `maxTurns` putaran lagi terlewati. Mengembalikan true
   * untuk melanjutkan. Tanpa callback ini, pekerjaan berhenti di batas.
   */
  onTurnLimit?: (turns: number) => Promise<boolean>
  /** Jeda sebelum setiap pengulangan panggilan model yang gagal sementara. */
  retryDelaysMs?: number[]
  /** Anggaran token untuk pesan yang dikirim; riwayat lama dipangkas di atasnya. */
  maxContextTokens?: number
  /**
   * Riwayat sesi sebelumnya untuk dilanjutkan. Diperbaiki lebih dulu, karena
   * sesi yang terputus dapat memuat panggilan tool tanpa hasil.
   */
  history?: Message[]
  /**
   * Dipanggil setiap kali pesan baru masuk ke riwayat, dalam urutan yang sama.
   * Riwayat yang dipulihkan dari `history` tidak ikut dilaporkan.
   */
  onMessage?: (message: Message) => void
  systemPrompt?: string
  /**
   * Membaca berkas aturan proyek. Dipanggil saat agent dibuat dan sebelum setiap
   * permintaan, supaya aturan yang baru diubah langsung berlaku.
   */
  instructions?: () => InstructionFile[]
}

const DEFAULT_MAX_TURNS = 40
/** Limit dan gangguan 9Router biasanya pulih dalam hitungan detik. */
export const DEFAULT_RETRY_DELAYS_MS = [2_000, 5_000, 15_000]

export const CANCELLED_TOOL_RESULT = 'Dibatalkan: pengguna menghentikan pekerjaan sebelum tool ini selesai.'
export const CANCELLED_REPLY = '(Dibatalkan oleh pengguna.)'
/** Awalan jawaban pengganti saat panggilan model gagal; diikuti pesan error dan `)`. */
export const FAILED_REPLY_PREFIX = '(Gagal: '
/** Awalan jawaban pengganti saat pengguna memilih berhenti di batas langkah. */
export const TURN_LIMIT_REPLY_PREFIX = '(Berhenti setelah '

export function turnLimitReply(turns: number): string {
  return `${TURN_LIMIT_REPLY_PREFIX}${turns} langkah atas permintaan pengguna; pekerjaan belum tentu selesai.)`
}

/** Menunggu, tetapi selesai lebih awal bila pengguna menghentikan pekerjaan. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}

export interface SendOptions {
  /** Menyala saat pengguna menghentikan pekerjaan, misalnya lewat Esc. */
  signal?: AbortSignal
}
/** Balasan kosong sesekali terjadi pada 9Router; sekali ulang sudah cukup. */
const EMPTY_REPLY_RETRIES = 1

export class Agent {
  private readonly messages: Message[] = []
  private readonly options: AgentOptions
  private instructionFiles: InstructionFile[]

  /** Hasil perbaikan riwayat yang dipulihkan, atau null untuk sesi baru. */
  readonly restored: RepairResult | null

  constructor(options: AgentOptions) {
    this.options = options
    this.instructionFiles = options.instructions?.() ?? []
    this.messages.push({
      role: 'system',
      content: composeSystemPrompt(options.systemPrompt ?? BOO_SYSTEM_PROMPT, this.instructionFiles),
    })
    this.restored = options.history?.length ? repairHistory(options.history) : null
    if (this.restored) this.messages.push(...this.restored.messages)
  }

  /** Aturan proyek yang sedang berlaku. */
  get instructions(): readonly InstructionFile[] {
    return this.instructionFiles
  }

  /** Memuat ulang aturan proyek; mengembalikan true bila isinya berubah. */
  private reloadInstructions(): boolean {
    if (!this.options.instructions) return false
    const files = this.options.instructions()
    if (instructionsSignature(files) === instructionsSignature(this.instructionFiles)) return false
    this.instructionFiles = files
    this.messages[0] = {
      role: 'system',
      content: composeSystemPrompt(this.options.systemPrompt ?? BOO_SYSTEM_PROMPT, files),
    }
    return true
  }

  get history(): readonly Message[] {
    return this.messages
  }

  /** Menjalankan satu permintaan pengguna sampai tuntas. */
  async *send(userInput: string, { signal }: SendOptions = {}): AsyncGenerator<AgentEvent> {
    if (this.reloadInstructions()) yield { type: 'instructions-reloaded', files: [...this.instructionFiles] }
    this.append({ role: 'user', content: userInput })
    const { provider, registry, maxTurns = DEFAULT_MAX_TURNS } = this.options

    for (let turn = 0; ; turn += 1) {
      if (turn > 0 && turn % maxTurns === 0) {
        const proceed = await this.options.onTurnLimit?.(turn) ?? false
        if (!proceed && !signal?.aborted) {
          this.settle('', turnLimitReply(turn))
          yield { type: 'turn-limit', turns: turn }
          return
        }
      }
      if (signal?.aborted) {
        this.settleCancellation('')
        yield { type: 'cancelled' }
        return
      }
      yield { type: 'turn-start', turn }
      let result
      // Teks yang sudah mengalir disimpan agar tidak hilang bila dihentikan di tengah.
      const partial = { text: '' }
      try {
        result = yield* this.streamTurn(provider, registry, signal, partial)
      } catch (error) {
        if (signal?.aborted) {
          this.settleCancellation(partial.text)
          yield { type: 'cancelled' }
          return
        }
        const message = error instanceof Error ? error.message : 'Panggilan model gagal.'
        // Riwayat tetap sah, dan model tahu jawabannya tadi tidak sampai.
        this.settle(partial.text, `${FAILED_REPLY_PREFIX}${message})`)
        yield { type: 'error', message }
        return
      }

      const { message } = result
      this.append(message)
      yield { type: 'turn-end', message }

      const toolCalls = message.tool_calls ?? []
      if (!toolCalls.length) return

      for (const call of toolCalls) {
        // Setelah dihentikan, tool yang tersisa tidak dijalankan tetapi tetap diberi
        // hasil — panggilan tool tanpa hasil membuat permintaan berikutnya ditolak.
        if (signal?.aborted) {
          this.pushToolResult(call.id, CANCELLED_TOOL_RESULT)
          continue
        }
        const tool = registry.get(call.function.name)
        if (!tool) {
          this.pushToolResult(call.id, `Gagal: tool "${call.function.name}" tidak dikenal.`)
          continue
        }

        let args: Record<string, unknown>
        try {
          args = JSON.parse(call.function.arguments || '{}')
        } catch {
          this.pushToolResult(call.id, `Gagal: arguments bukan JSON valid: ${call.function.arguments}`)
          continue
        }

        const preview = tool.preview(args as never)
        if (tool.risk === 'confirm') {
          // Pratinjau gagal bukan alasan membatalkan; izin tetap diminta,
          // hanya saja tanpa diff.
          let detail: DiffLine[] | null
          try {
            detail = await tool.detail?.(args as never, { workspace: this.options.workspace }) ?? null
          } catch {
            detail = null
          }
          const answer = await this.options.askPermission({ name: tool.name, preview, args, detail })
          if (signal?.aborted) {
            this.pushToolResult(call.id, CANCELLED_TOOL_RESULT)
            continue
          }
          const decision = typeof answer === 'boolean' ? { allowed: answer } : answer
          if (!decision.allowed) {
            const feedback = decision.feedback?.trim()
            yield { type: 'tool-denied', name: tool.name, callId: call.id, ...(feedback ? { feedback } : {}) }
            this.pushToolResult(call.id, feedback
              ? `Ditolak oleh pengguna, dengan arahan: ${feedback}\nIkuti arahan itu; jangan ulangi tindakan yang ditolak tanpa perubahan.`
              : 'Ditolak oleh pengguna. Jangan ulangi; tanyakan langkah berikutnya.')
            continue
          }
        }

        yield { type: 'tool-start', name: tool.name, preview, callId: call.id, args }
        let content: string
        let isError: boolean
        // Keluaran dari callback ditampung lalu diteruskan sebagai event selagi tool
        // berjalan; generator tidak bisa yield dari dalam callback.
        const chunks: string[] = []
        let wake: (() => void) | null = null
        let settled = false
        const running = tool.run(args as never, {
          workspace: this.options.workspace,
          signal,
          onOutput: (chunk) => {
            chunks.push(chunk)
            wake?.()
          },
        })
        running.then(() => undefined, () => undefined).finally(() => {
          settled = true
          wake?.()
        })
        for (;;) {
          if (chunks.length) {
            yield { type: 'tool-output', name: tool.name, callId: call.id, chunk: chunks.splice(0).join('') }
            continue
          }
          if (settled) break
          await new Promise<void>((resolve) => {
            // Diperiksa ulang di dalam executor, yang berjalan sinkron: keluaran atau
            // selesainya tool di antara pemeriksaan di atas tidak boleh terlewat.
            if (settled || chunks.length) resolve()
            else wake = resolve
          })
          wake = null
        }
        try {
          const outcome = await running
          content = outcome.content
          isError = Boolean(outcome.isError)
        } catch (error) {
          content = `Gagal: ${error instanceof Error ? error.message : 'error tak dikenal'}`
          isError = true
        }
        // Tool yang terhenti karena pembatalan bukan kegagalan yang perlu dilaporkan.
        yield { type: 'tool-end', name: tool.name, callId: call.id, content, isError, cancelled: Boolean(signal?.aborted) }
        this.pushToolResult(call.id, content)
      }

      if (signal?.aborted) {
        this.settleCancellation('')
        yield { type: 'cancelled' }
        return
      }
    }
  }

  /**
   * Merapikan riwayat setelah pengguna menghentikan pekerjaan, di titik mana pun.
   *
   * Riwayat harus tetap sah untuk permintaan berikutnya: setiap panggilan tool punya
   * hasil, dan giliran terakhir milik assistant. Tanpa itu, pertanyaan berikutnya
   * akan ditolak model — pertanyaan baru tepat setelah pesan user atau hasil tool.
   * Teks jawaban yang sudah terlanjur tampil disimpan beserta tanda dibatalkan.
   */
  private settleCancellation(partialText: string): void {
    this.settle(partialText, CANCELLED_REPLY)
  }

  /** Melengkapi hasil tool yang hilang dan menutup giliran dengan tanda `marker`. */
  private settle(partialText: string, marker: string): void {
    const lastAssistant = [...this.messages].reverse().find((message) => message.role === 'assistant')
    for (const call of lastAssistant?.tool_calls ?? []) {
      const answered = this.messages.some((message) => message.role === 'tool' && message.tool_call_id === call.id)
      if (!answered) this.pushToolResult(call.id, CANCELLED_TOOL_RESULT)
    }
    const last = this.messages.at(-1)
    if (last?.role === 'assistant' && !last.tool_calls?.length) return
    const text = partialText.trim()
    this.append({ role: 'assistant', content: text ? `${text}\n\n${marker}` : marker })
  }

  /** Meneruskan event streaming dan mengulang sekali bila balasannya kosong. */
  private async *streamTurn(
    provider: NineRouterProvider,
    registry: ToolRegistry,
    signal: AbortSignal | undefined,
    partial: { text: string },
  ) {
    for (let attempt = 0; ; attempt += 1) {
      // Riwayat penuh tetap disimpan; yang dipangkas hanya salinan yang dikirim.
      const trimmed = trimToBudget(
        this.messages,
        this.options.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS,
      )
      if (trimmed.droppedMessages && attempt === 0) {
        yield {
          type: 'context-trimmed',
          droppedMessages: trimmed.droppedMessages,
          estimatedTokens: trimmed.estimatedTokens,
        } as AgentEvent
      }
      const delays = this.options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS
      let result
      for (let retry = 0; ; retry += 1) {
        const stream = provider.stream(trimmed.messages, registry.schemas(), signal)
        partial.text = ''
        try {
          let next = await stream.next()
          while (!next.done) {
            if (next.value.type === 'text') partial.text += next.value.delta
            yield next.value as AgentEvent
            next = await stream.next()
          }
          result = next.value
          break
        } catch (error) {
          const transient = error instanceof ProviderError && error.retryable
          if (!transient || retry >= delays.length || signal?.aborted) throw error
          // Jeda dari 9Router dihormati, ditambah sedikit agar tidak tepat di batasnya.
          const delayMs = error.retryAfterMs !== undefined ? error.retryAfterMs + 500 : delays[retry]
          yield { type: 'retry', attempt: retry + 1, maxAttempts: delays.length, delayMs, message: error.message } as AgentEvent
          await sleep(delayMs, signal)
          if (signal?.aborted) throw error
        }
      }

      const empty = !result.message.content?.trim() && !result.message.tool_calls?.length
      if (!empty || attempt >= EMPTY_REPLY_RETRIES || signal?.aborted) return result
    }
  }

  private pushToolResult(callId: string, content: string): void {
    this.append({ role: 'tool', tool_call_id: callId, content })
  }

  /** Satu-satunya jalan pesan baru masuk ke riwayat, agar selalu terlaporkan. */
  private append(message: Message): void {
    this.messages.push(message)
    this.options.onMessage?.(message)
  }
}
