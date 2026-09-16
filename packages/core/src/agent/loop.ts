/**
 * Agent loop: kirim percakapan, jalankan tool yang diminta, ulangi sampai model
 * berhenti meminta tool. Lapisan ini tidak tahu apa pun soal terminal maupun
 * browser — seluruh keluarannya berupa event, dan izin dimintakan lewat
 * callback. Itulah yang membuatnya bisa dipakai ulang oleh CLI dan web nanti.
 */

import type { Message } from '../domain/message.ts'
import type { DiffLine } from '../tools/diff.ts'
import type { ToolRegistry } from '../domain/tool.ts'
import type { NineRouterProvider } from '../provider/nineRouter.ts'
import { DEFAULT_MAX_CONTEXT_TOKENS, trimToBudget } from './context.ts'
import { BOO_SYSTEM_PROMPT } from './prompt.ts'

export type AgentEvent =
  | { type: 'reasoning'; delta: string }
  | { type: 'text'; delta: string }
  | { type: 'tool-start'; name: string; preview: string; callId: string }
  | { type: 'tool-end'; name: string; callId: string; content: string; isError: boolean }
  | { type: 'tool-denied'; name: string; callId: string }
  | { type: 'turn-end'; message: Message }
  | { type: 'context-trimmed'; droppedMessages: number; estimatedTokens: number }
  | { type: 'error'; message: string }

/** Ditanyakan sebelum tool berisiko dijalankan. */
export type PermissionAsker = (request: {
  name: string
  preview: string
  args: Record<string, unknown>
  /** Diff perubahan bila tool menyediakannya; null berarti tak ada yang berubah. */
  detail: DiffLine[] | null
}) => Promise<boolean>

export interface AgentOptions {
  provider: NineRouterProvider
  registry: ToolRegistry
  workspace: string
  askPermission: PermissionAsker
  /** Batas putaran agar model yang tersesat tidak berputar selamanya. */
  maxTurns?: number
  /** Anggaran token untuk pesan yang dikirim; riwayat lama dipangkas di atasnya. */
  maxContextTokens?: number
  systemPrompt?: string
}

const DEFAULT_MAX_TURNS = 24
/** Balasan kosong sesekali terjadi pada 9Router; sekali ulang sudah cukup. */
const EMPTY_REPLY_RETRIES = 1

export class Agent {
  private readonly messages: Message[] = []
  private readonly options: AgentOptions

  constructor(options: AgentOptions) {
    this.options = options
    this.messages.push({
      role: 'system',
      content: options.systemPrompt ?? BOO_SYSTEM_PROMPT,
    })
  }

  get history(): readonly Message[] {
    return this.messages
  }

  /** Menjalankan satu permintaan pengguna sampai tuntas. */
  async *send(userInput: string): AsyncGenerator<AgentEvent> {
    this.messages.push({ role: 'user', content: userInput })
    const { provider, registry, maxTurns = DEFAULT_MAX_TURNS } = this.options

    for (let turn = 0; turn < maxTurns; turn += 1) {
      let result
      try {
        result = yield* this.streamTurn(provider, registry)
      } catch (error) {
        yield { type: 'error', message: error instanceof Error ? error.message : 'Panggilan model gagal.' }
        return
      }

      const { message } = result
      this.messages.push(message)
      yield { type: 'turn-end', message }

      const toolCalls = message.tool_calls ?? []
      if (!toolCalls.length) return

      for (const call of toolCalls) {
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
          const allowed = await this.options.askPermission({ name: tool.name, preview, args, detail })
          if (!allowed) {
            yield { type: 'tool-denied', name: tool.name, callId: call.id }
            this.pushToolResult(call.id, 'Ditolak oleh pengguna. Jangan ulangi; tanyakan langkah berikutnya.')
            continue
          }
        }

        yield { type: 'tool-start', name: tool.name, preview, callId: call.id }
        let content: string
        let isError: boolean
        try {
          const outcome = await tool.run(args as never, { workspace: this.options.workspace })
          content = outcome.content
          isError = Boolean(outcome.isError)
        } catch (error) {
          content = `Gagal: ${error instanceof Error ? error.message : 'error tak dikenal'}`
          isError = true
        }
        yield { type: 'tool-end', name: tool.name, callId: call.id, content, isError }
        this.pushToolResult(call.id, content)
      }
    }

    yield { type: 'error', message: `Berhenti setelah ${maxTurns} putaran tanpa jawaban akhir.` }
  }

  /** Meneruskan event streaming dan mengulang sekali bila balasannya kosong. */
  private async *streamTurn(provider: NineRouterProvider, registry: ToolRegistry) {
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
      const stream = provider.stream(trimmed.messages, registry.schemas())
      let next = await stream.next()
      while (!next.done) {
        yield next.value as AgentEvent
        next = await stream.next()
      }

      const result = next.value
      const empty = !result.message.content?.trim() && !result.message.tool_calls?.length
      if (!empty || attempt >= EMPTY_REPLY_RETRIES) return result
    }
  }

  private pushToolResult(callId: string, content: string): void {
    this.messages.push({ role: 'tool', tool_call_id: callId, content })
  }
}
