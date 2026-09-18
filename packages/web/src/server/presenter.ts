/**
 * Menerjemahkan event agent menjadi unsur tampilan web selama satu permintaan.
 *
 * Aturannya sama dengan tampilan CLI: pekerjaan tool diringkas per fase, daftar
 * tugas tampil utuh, kegagalan tidak disembunyikan, dan label aktivitas hanya
 * berasal dari kejadian nyata.
 */

import type { AgentEvent } from '@boo/core'
import { describeArgs, lastOutputLine, ToolCallProgress, toolActivity, turnActivity } from '@boo/core/presentation/activity.ts'
import { PhaseTally, phaseOf, type Phase } from '@boo/core/presentation/phases.ts'
import { parseTodos, todoProgress } from '@boo/core'
import type { NoticeVariant, ViewItem } from '@boo/core/presentation/view.ts'
import type { StatusView } from '../protocol.ts'

export interface PresenterSink {
  /** Menambah unsur, atau mengganti unsur dengan id yang sama. `toEnd` memindahkannya ke akhir. */
  putItem(item: ViewItem, toEnd?: boolean): void
  appendText(id: string, text: string): void
  setStatus(status: StatusView | null): void
  isLastItem(id: string): boolean
  nextId(): string
}

interface PhaseState {
  phase: Phase
  startedAt: number
  tally: PhaseTally
  item: Extract<ViewItem, { kind: 'phase' }> | null
}

/** "ubah hitung.js" menjadi "hitung.js", untuk ringkasan berkas yang diubah. */
function targetOf(preview: string): string {
  return preview.split(/\s+/)[1] ?? ''
}

export class RequestPresenter {
  private readonly sink: PresenterSink
  private phase: PhaseState | null = null
  private answerId: string | null = null
  private currentTask = ''
  private status: StatusView | null = null
  private readonly toolCalls = new Map<number, ToolCallProgress>()
  private readonly previews = new Map<string, string>()
  private readonly outputs = new Map<string, string>()

  constructor(sink: PresenterSink) {
    this.sink = sink
  }

  handle(event: AgentEvent): void {
    switch (event.type) {
      case 'turn-start':
        this.toolCalls.clear()
        this.show(turnActivity(event.turn), this.currentTask)
        break

      case 'reasoning':
        if (!this.answerId) this.show('Thinking', this.currentTask)
        break

      case 'text':
        if (!this.answerId) {
          this.commitPhase()
          this.answerId = this.sink.nextId()
          this.sink.putItem({ kind: 'answer', id: this.answerId, markdown: '' })
        }
        this.sink.appendText(this.answerId, event.delta)
        this.show('Generating', '')
        break

      case 'tool-call': {
        this.answerId = null
        if (event.name === 'todo_write') {
          this.show('Planning', '')
          break
        }
        let progress = this.toolCalls.get(event.index)
        if (!progress || progress.name !== event.name) {
          progress = new ToolCallProgress(event.name)
          this.toolCalls.set(event.index, progress)
        }
        progress.add(event.delta)
        this.enterPhase(phaseOf(event.name))
        this.show(toolActivity(event.name), progress.describe())
        break
      }

      case 'tool-start':
        this.answerId = null
        this.previews.set(event.callId, event.preview)
        if (event.name === 'todo_write') {
          const todos = parseTodos(event.args.todos)
          if (typeof todos !== 'string') {
            this.commitPhase()
            this.sink.putItem({ kind: 'todos', id: this.sink.nextId(), items: todos })
            this.currentTask = todoProgress(todos).current ?? ''
          }
          break
        }
        this.enterPhase(phaseOf(event.name))
        this.show(toolActivity(event.name), describeArgs(event.name, event.args))
        break

      case 'tool-output': {
        const output = ((this.outputs.get(event.callId) ?? '') + event.chunk).slice(-4_000)
        this.outputs.set(event.callId, output)
        const line = lastOutputLine(output)
        if (line) this.show(toolActivity(event.name), line)
        break
      }

      case 'tool-end': {
        this.outputs.delete(event.callId)
        if (event.cancelled || (event.name === 'todo_write' && !event.isError)) break
        const phase = this.enterPhase(phaseOf(event.name))
        phase.tally.record(event.name, event.isError, targetOf(this.previews.get(event.callId) ?? ''))
        this.updatePhase(phase)
        // Kegagalan tidak boleh disembunyikan di balik ringkasan.
        if (event.isError) {
          const detail = event.content.split('\n').slice(0, 6).join('\n')
          this.notice('error', `${event.name} gagal: ${detail}`)
        }
        break
      }

      case 'turn-end':
        if (event.message.tool_calls?.length) this.answerId = null
        break

      case 'retry': {
        this.answerId = null
        const reason = event.message.split('\n')[0].slice(0, 160)
        this.notice('retry', `${reason} · mencoba lagi dalam ${Math.ceil(event.delayMs / 1_000)}s (${event.attempt}/${event.maxAttempts})`)
        this.show('Retrying', `percobaan ${event.attempt} dari ${event.maxAttempts}`)
        break
      }

      case 'compacting':
        this.answerId = null
        this.show('Compacting', 'meringkas percakapan lama')
        break

      case 'compacted':
        this.notice('compacted', `Konteks diringkas: ${event.summarizedMessages} pesan lama menjadi ringkasan (~${event.estimatedTokens} token terkirim)`)
        break

      case 'compaction-failed':
        this.notice('info', `Ringkasan konteks gagal (${event.message.split('\n')[0].slice(0, 120)}); pesan lama dipangkas`)
        break

      case 'context-trimmed':
        this.notice('info', `Konteks dipangkas: ${event.droppedMessages} pesan lama dibuang (~${event.estimatedTokens} token terkirim)`)
        break

      case 'instructions-reloaded':
        this.notice('info', event.files.length
          ? `Aturan proyek dimuat ulang: ${event.files.map((file) => file.label).join(', ')}`
          : 'Aturan proyek tidak lagi ada; Boo bekerja tanpa aturan proyek')
        break

      case 'cancelled':
        this.commitPhase()
        this.notice('cancelled', 'Dibatalkan')
        break

      case 'turn-limit':
        this.commitPhase()
        this.notice('turn-limit', `Berhenti setelah ${event.turns} langkah. Ketik "lanjutkan" untuk meneruskan pekerjaannya.`)
        break

      case 'error':
        this.commitPhase()
        this.notice('error', event.message)
        break

      default:
        break
    }
  }

  /** Keputusan izin dicatat di antara pekerjaan; fase berjalan tetap dilanjutkan. */
  decision(allowed: boolean, text: string): void {
    this.sink.putItem({ kind: 'decision', id: this.sink.nextId(), allowed, text })
  }

  /** Menutup permintaan: fase terakhir dibekukan dan status dihapus. */
  finish(): void {
    this.commitPhase()
    this.status = null
    this.sink.setStatus(null)
  }

  /** Membekukan fase berjalan, misalnya sebelum pertanyaan batas langkah. */
  commitPhase(): void {
    const phase = this.phase
    this.phase = null
    if (!phase?.item) return
    this.sink.putItem({ ...phase.item, live: false, durationMs: Date.now() - phase.startedAt })
  }

  private notice(variant: NoticeVariant, text: string): void {
    this.sink.putItem({ kind: 'notice', id: this.sink.nextId(), variant, text })
  }

  private enterPhase(phase: Phase): PhaseState {
    if (this.phase && this.phase.phase !== phase) this.commitPhase()
    this.phase ??= { phase, startedAt: Date.now(), tally: new PhaseTally(), item: null }
    return this.phase
  }

  private updatePhase(state: PhaseState): void {
    const summary = state.phase === 'exploring' ? state.tally.exploring() : state.tally.applying()
    // Unsur fase baru dibuat saat tool pertama selesai: fase tanpa hasil tidak ditampilkan.
    const item: Extract<ViewItem, { kind: 'phase' }> = state.item
      ? { ...state.item, summary }
      : { kind: 'phase', id: this.sink.nextId(), phase: state.phase, summary, live: true }
    const moved = Boolean(state.item) && !this.sink.isLastItem(item.id)
    state.item = item
    this.sink.putItem(item, moved)
  }

  private show(label: string, detail: string): void {
    // Waktu berjalan milik aktivitas; keterangan yang berubah tidak mengulangnya.
    const startedAt = this.status?.label === label ? this.status.startedAt : Date.now()
    if (this.status?.label === label && this.status.detail === detail) return
    this.status = { label, detail, startedAt }
    this.sink.setStatus(this.status)
  }
}
