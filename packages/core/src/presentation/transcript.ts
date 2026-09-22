/**
 * Menyusun ulang riwayat sesi menjadi unsur tampilan, seperti saat berlangsung.
 *
 * Pertanyaan tampil seperti diketik, jawaban sebagai markdown, dan pekerjaan tool
 * diringkas dengan fase yang sama persis dengan tampilan langsung. Isi hasil tool —
 * isi berkas, keluaran perintah — tidak ditampilkan.
 */

import { splitUndoNote } from '../agent/checkpoints.ts'
import { promptCommandTitle } from '../agent/commands.ts'
import { completionHookFeedback } from '../agent/hooks.ts'
import { referencedPromptTitle } from '../agent/references.ts'
import { CANCELLED_REPLY, FAILED_REPLY_PREFIX, TURN_LIMIT_REPLY_PREFIX } from '../agent/loop.ts'
import { isImplementPlanRequest, planPromptTitle } from '../agent/planning.ts'
import type { Message } from '../domain/message.ts'
import { specPromptTitle } from '../spec/specs.ts'
import { parseTodos } from '../tools/todo.ts'
import { userAnswerSummary } from '../tools/askUser.ts'
import { steeringPromptTitle, STEERING_SKIPPED_TOOL_RESULT } from '../agent/steering.ts'
import { PhaseTally, phaseOf, type Phase } from './phases.ts'
import type { ViewItem } from './view.ts'

const TOOL_TITLE: Record<string, string> = {
  write_file: 'Tulis berkas',
  edit_file: 'Ubah berkas',
  apply_patch: 'Terapkan patch',
  bash: 'Jalankan perintah',
  diagnostics: 'Jalankan diagnostics',
  lsp: 'Query language server',
  delegate: 'Delegasikan investigasi',
  delegate_write: 'Delegasikan implementasi',
  mcp_list_tools: 'Jalankan MCP server',
  mcp_call: 'Panggil MCP tool',
  open_app: 'Buka aplikasi',
  browser_tabs: 'Lihat tab browser',
  browser_open: 'Buka tab browser',
  browser_navigate: 'Navigasi tab browser',
  browser_snapshot: 'Baca halaman browser',
  browser_diagnostics: 'Diagnostik browser',
  browser_click: 'Klik di browser',
  browser_type: 'Ketik di browser',
  browser_select: 'Pilih dropdown browser',
  browser_press: 'Tekan tombol browser',
  whatsapp_send_message: 'Kirim pesan WhatsApp',
}

interface PendingCall {
  name: string
  args: Record<string, unknown>
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw || '{}')
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

/** Setiap pesan user membuka satu tukar-jawab. */
function splitExchanges(messages: readonly Message[]): Message[][] {
  const exchanges: Message[][] = []
  for (const message of messages) {
    if (message.role === 'system') continue
    if (message.role === 'user' || !exchanges.length) exchanges.push([])
    exchanges[exchanges.length - 1].push(message)
  }
  return exchanges
}

/**
 * Jawaban pengganti yang ditulis agent — dibatalkan, gagal, berhenti di batas
 * langkah — dipisahkan dari teks jawaban dan menjadi pemberitahuan.
 */
function splitMarker(content: string): { text: string; notice: Omit<Extract<ViewItem, { kind: 'notice' }>, 'id' | 'kind'> | null } {
  const at = content.lastIndexOf('\n\n')
  const text = at === -1 ? '' : content.slice(0, at)
  const tail = at === -1 ? content : content.slice(at + 2)
  if (tail === CANCELLED_REPLY) return { text, notice: { variant: 'cancelled', text: 'Dibatalkan' } }
  if (tail.startsWith(FAILED_REPLY_PREFIX) && tail.endsWith(')')) {
    return { text, notice: { variant: 'error', text: tail.slice(FAILED_REPLY_PREFIX.length, -1) } }
  }
  if (tail.startsWith(TURN_LIMIT_REPLY_PREFIX)) {
    const turns = /^\(Berhenti setelah (\d+)/.exec(tail)?.[1] ?? '?'
    return { text, notice: { variant: 'turn-limit', text: `berhenti setelah ${turns} langkah` } }
  }
  return { text: content, notice: null }
}

function denialText(call: PendingCall, content: string): string {
  const title = TOOL_TITLE[call.name] ?? call.name
  const { command, path, id, recipient } = call.args
  const target = typeof command === 'string' ? ` · ${command}` : typeof path === 'string' ? ` ${path}` : typeof id === 'string' ? ` ${id}` : typeof recipient === 'string' ? ` ${recipient}` : ''
  const feedback = /dengan arahan: ([^\n]*)/.exec(content)?.[1]
  return `${title}${target} · ditolak${feedback ? `: ${feedback}` : ''}`
}

function buildExchange(exchange: readonly Message[], prefix: string): ViewItem[] {
  const items: ViewItem[] = []
  const nextId = () => `${prefix}-${items.length}`
  const tally = new PhaseTally()
  let phase: Phase | null = null
  let recorded = 0
  const calls = new Map<string, PendingCall>()

  const flushPhase = () => {
    if (phase && recorded) {
      items.push({ kind: 'phase', id: nextId(), phase, summary: phase === 'exploring' ? tally.exploring() : tally.applying() })
    }
    phase = null
    recorded = 0
    tally.reset()
  }

  for (const message of exchange) {
    if (message.role === 'user') {
      const { note, text } = splitUndoNote(message.content ?? '')
      const original = referencedPromptTitle(text) ?? text
      const steering = steeringPromptTitle(original)
      const hookFeedback = completionHookFeedback(text)
      if (hookFeedback !== null) {
        items.push({ kind: 'notice', id: nextId(), variant: 'error', text: `Hook on_complete meminta perbaikan: ${hookFeedback}` })
        if (steering === null) continue
      }
      const spec = specPromptTitle(original)
      const plan = planPromptTitle(original)
      const command = promptCommandTitle(original)
      const visibleText = steering ?? (spec !== null ? `/spec · ${spec}` : plan !== null ? `/plan ${plan}` : isImplementPlanRequest(original) ? '/implement' : command ?? original)
      items.push({
        kind: 'user',
        id: nextId(),
        text: visibleText,
        ...(message.images?.length ? { attachments: message.images.map((image) => image.name) } : {}),
        ...(spec === null ? {} : { spec }),
        ...(note ? { afterUndo: true } : {}),
        ...(steering === null ? {} : { steering: true }),
      })
      continue
    }

    if (message.role === 'assistant') {
      const { text, notice } = splitMarker(message.content ?? '')
      if (text.trim() || notice) flushPhase()
      if (text.trim()) items.push({ kind: 'answer', id: nextId(), markdown: text.trimEnd() })
      if (notice) items.push({ kind: 'notice', id: nextId(), ...notice })
      for (const call of message.tool_calls ?? []) {
        calls.set(call.id, { name: call.function.name, args: parseArgs(call.function.arguments) })
      }
      continue
    }

    if (message.role === 'tool') {
      const call = calls.get(message.tool_call_id ?? '')
      if (!call) continue
      const content = message.content ?? ''
      if (content === STEERING_SKIPPED_TOOL_RESULT) continue
      if (call.name === 'todo_write') {
        const todos = parseTodos(call.args.todos)
        if (typeof todos !== 'string' && !content.startsWith('Gagal')) {
          flushPhase()
          items.push({ kind: 'todos', id: nextId(), items: todos })
        }
        continue
      }
      if (call.name === 'ask_user') {
        const summary = userAnswerSummary(content)
        if (summary) {
          flushPhase()
          items.push({ kind: 'decision', id: nextId(), allowed: true, text: `Jawaban · ${summary}` })
        }
        continue
      }
      // Tool yang terhenti karena pembatalan tidak dihitung, seperti tampilan langsung.
      if (content.startsWith('Dibatalkan')) continue
      if (content.startsWith('Ditolak oleh pengguna')) {
        flushPhase()
        items.push({ kind: 'decision', id: nextId(), allowed: false, text: denialText(call, content) })
        continue
      }
      // Fase ditentukan dari hasil, bukan dari panggilan: bila salah satu dari beberapa
      // panggilan sekaligus ditolak, hasil yang lain tetap harus masuk ringkasan.
      const nextPhase = phaseOf(call.name)
      if (phase !== nextPhase) {
        flushPhase()
        phase = nextPhase
      }
      const target = typeof call.args.path === 'string' ? call.args.path : ''
      tally.record(call.name, content.startsWith('Gagal'), target)
      recorded += 1
    }
  }
  flushPhase()
  return items
}

/** Riwayat sebagai tukar-jawab berisi unsur tampilan, yang terlama lebih dulu. */
export function buildTranscript(messages: readonly Message[]): ViewItem[][] {
  return splitExchanges(messages).map((exchange, index) => buildExchange(exchange, `h${index}`))
}
