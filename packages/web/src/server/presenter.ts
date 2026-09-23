/**
 * Menerjemahkan event agent menjadi unsur tampilan web selama satu permintaan.
 *
 * Aturannya sama dengan tampilan CLI: pekerjaan tool diringkas per fase, daftar
 * tugas tampil utuh, kegagalan tidak disembunyikan, dan label aktivitas hanya
 * berasal dari kejadian nyata.
 */

import { DIFFICULTY_LABEL, describeSelection, formatFailurePostmortem, groupModels, type AgentEvent } from '@boo/core'
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
      case 'model-routing':
        this.show('Selecting model', 'menilai kesulitan tugas')
        break
      case 'model-selected': {
        const label = describeSelection(groupModels([event.model]), event.model, event.reasoningEffort)
        this.notice('info', `Auto · ${label} · ${DIFFICULTY_LABEL[event.difficulty]}${event.source === 'local' ? ' (perkiraan lokal)' : ''} · ${event.reason}`)
        break
      }
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
        if (event.name === 'todo_write' || event.name === 'ask_user') {
          this.show(event.name === 'ask_user' ? 'Waiting' : 'Planning', event.name === 'ask_user' ? 'menunggu jawaban pengguna' : '')
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
        if (event.name === 'ask_user') {
          this.show('Waiting', 'menunggu jawaban pengguna')
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

      case 'tool-cache-hit':
        this.show(toolActivity(event.name), `cache ${event.ref} · hemat ${event.savedCharacters.toLocaleString('id-ID')} karakter`)
        break

      case 'tool-result-truncated':
        this.show(toolActivity(event.name), `${event.originalCharacters.toLocaleString('id-ID')} karakter · ${event.ref ? `tersimpan ${event.ref}` : 'bagian tengah tidak disimpan'}`)
        break

      case 'tool-parallel':
        if (event.stage === 'started') this.show('Exploring', `${event.calls} tool paralel · ${event.tools.join(', ')}`)
        break

      case 'tool-recovery':
        this.show('Recovering', `${event.category} timeout · batas berikutnya ${Math.ceil(event.nextIdleTimeoutMs / 1_000)}s`)
        break

      case 'tool-end': {
        this.outputs.delete(event.callId)
        if (event.cancelled || ((event.name === 'todo_write' || event.name === 'ask_user') && !event.isError)) break
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

      case 'verification-repair':
        if (event.stage === 'repaired') this.notice('info', `Verification repair berhasil dalam ${event.round} putaran.`)
        else if (event.stage === 'exhausted') this.notice('error', `Verification repair berhenti aman setelah ${event.round}/${event.maxRounds} putaran.`)
        else this.show('Repairing', `verifikasi · putaran ${event.round}/${event.maxRounds}`)
        break

      case 'change-impact':
        this.show('Checking', `${event.affectedFiles} file terdampak · ${event.edges} relasi · blast radius ${event.blastRadius}${event.truncated ? ' · dibatasi' : ''}`)
        break

      case 'lsp-session':
        this.show(event.stage === 'reused' ? 'Checking' : 'Starting', `LSP ${event.stage} · ${event.openDocuments} dokumen aktif`)
        break

      case 'tool-invalid':
        this.commitPhase()
        this.status = null
        this.sink.setStatus(null)
        this.notice('error', `${event.name} tidak dijalankan karena argumen tidak valid:\n${event.issues.join('\n')}`)
        break

      case 'tool-loop':
        this.commitPhase()
        this.notice(event.stage === 'warning' ? 'info' : 'error', event.stage === 'warning'
          ? event.repetitions === 1
            ? `${event.name} ditolak pengguna; pengulangan identik berikutnya akan diblokir.`
            : `${event.name} memberi hasil identik berulang; Boo diminta mengganti pendekatan.`
          : event.stage === 'blocked'
            ? `${event.name} diblokir sebelum dijalankan karena panggilan identik stagnan.`
            : `Task dihentikan: ${event.name} tetap diulang setelah diperingatkan dan diblokir.`)
        break

      case 'tool-protocol':
        this.commitPhase()
        this.status = null
        this.sink.setStatus(null)
        this.notice(event.stage === 'warning' ? 'info' : 'error', event.stage === 'warning'
          ? `Model menghasilkan function call invalid selama ${event.consecutiveTurns} putaran; Boo meminta koreksi terakhir.`
          : event.stage === 'fallback'
            ? `Function-calling ${event.model} tidak stabil; mode Auto memilih model cadangan.`
            : `Task dihentikan karena function call tetap invalid selama ${event.consecutiveTurns} putaran.`)
        break

      case 'hook-start':
        this.show('Running', `hook ${event.event}:${event.id}`)
        break

      case 'hook-end':
        this.status = null
        this.sink.setStatus(null)
        if (!event.denied) this.notice(event.success ? 'success' : 'error', `Hook ${event.event}:${event.id} · ${event.success ? 'selesai' : event.content.split('\n')[0]}`)
        break

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
        this.notice('info', `Konteks dipangkas: ${event.droppedMessages} pesan dibuang, ${event.prioritizedMessages} pesan relevan lama dipertahankan${event.dependencyMessages ? `, ${event.dependencyMessages} pesan dependency melalui ${event.dependencyEdges ?? 0} relasi` : ''} (~${event.estimatedTokens} token terkirim)`)
        break

      case 'workspace-changed': {
        const kinds = { modified: 'diubah', deleted: 'dihapus', unsafe: 'path tidak aman', unreadable: 'tak terbaca' } as const
        const files = event.files.map((file) => `${file.path} (${kinds[file.kind]})`)
        if (event.remaining) files.push(`… ${event.remaining} file lain`)
        this.notice(event.files.some((file) => file.kind === 'unsafe' || file.kind === 'unreadable') ? 'error' : 'info', `Workspace berubah di luar Boo: ${files.join(', ')}. Boo diminta membaca ulang sebelum melanjutkan.`)
        break
      }

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

      case 'verification-needed':
        this.show('Verifying', event.tests?.length
          ? `${event.tests.slice(0, 3).join(', ')}${event.tests.length > 3 ? ` +${event.tests.length - 3}` : ''}`
          : event.commands?.[0] ?? event.files.join(', '))
        break

      case 'verification-incomplete':
        this.notice('error', `${event.attempted ? 'Verifikasi belum berhasil' : 'Belum ada verifikasi'} untuk ${event.files.join(', ')}`)
        break

      case 'prompt-injection-detected':
        this.commitPhase()
        this.notice('error', `Prompt injection dicurigai pada ${event.tool} (${event.categories.join(', ')}). Aksi berisiko berikutnya wajib persetujuan baru.`)
        break

      case 'critic-start':
        this.answerId = null
        this.show('Reviewing', `review otomatis ${event.round}`)
        break

      case 'critic-end':
        this.status = null
        this.sink.setStatus(null)
        if (event.status === 'pass') this.notice('success', `Review otomatis lulus · ${event.model}`)
        else if (event.status === 'findings') this.notice('error', `Reviewer menemukan ${event.findings} masalah; Boo akan memeriksanya`)
        else if (event.status === 'error') this.notice('info', `Review otomatis dilewati: ${event.message ?? 'reviewer gagal'}`)
        else this.notice('info', 'Batas review otomatis tercapai; hasil terakhir dipertahankan.')
        break

      case 'steering':
        this.answerId = null
        this.commitPhase()
        this.notice('info', `${event.messages.length} arahan tengah jalan diterapkan; Boo merencanakan ulang.`)
        break

      case 'risk-assessed':
        if (event.assessment.level !== 'low') this.notice(event.assessment.level === 'high' ? 'error' : 'info', `Risiko ${event.assessment.level} · ${event.assessment.reasons.join('; ')}`)
        break

      case 'risk-verification-weak':
        this.notice('error', 'Perubahan berisiko tinggi hanya memiliki bukti verifikasi dasar; reviewer otomatis tetap dijalankan.')
        break

      case 'failure-postmortem':
        this.commitPhase()
        this.notice('error', formatFailurePostmortem(event.report))
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
