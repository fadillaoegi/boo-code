/**
 * Menampilkan ulang percakapan sesi yang dilanjutkan, seperti saat berlangsung.
 *
 * Membuka sesi lama seharusnya terasa kembali ke halaman chat-nya, bukan membaca
 * ringkasan. Pertanyaan tampil seperti diketik, jawaban dirender sebagai markdown,
 * dan pekerjaan tool diringkas dengan baris fase yang sama persis dengan tampilan
 * langsung. Isi hasil tool — isi berkas, keluaran perintah — tidak ditampilkan,
 * sama seperti saat sesi berjalan.
 */

import { CANCELLED_REPLY, FAILED_REPLY_PREFIX, splitUndoNote, TURN_LIMIT_REPLY_PREFIX, type Message } from '@boo/core'
import { MarkdownRenderer } from './markdown.ts'
import { PhaseTally, phaseLine, phaseOf, type Phase } from './status.ts'
import { theme } from './theme.ts'

/** Sesi panjang dibatasi pada tukar-jawab terakhir agar layar tidak banjir. */
export const MAX_REPLAYED_EXCHANGES = 20

const TOOL_TITLE: Record<string, string> = {
  write_file: 'Tulis berkas',
  edit_file: 'Ubah berkas',
  bash: 'Jalankan perintah',
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

/** Pertanyaan dipotong menjadi tukar-jawab: setiap pesan user membuka satu. */
function splitExchanges(messages: Message[]): Message[][] {
  const exchanges: Message[][] = []
  for (const message of messages) {
    if (message.role === 'system') continue
    if (message.role === 'user' || !exchanges.length) exchanges.push([])
    exchanges[exchanges.length - 1].push(message)
  }
  return exchanges
}

/** Catatan penolakan, dibaca dari hasil tool yang ditulis agent saat ditolak. */
function denialLine(call: PendingCall, content: string): string {
  const title = TOOL_TITLE[call.name] ?? call.name
  const { command, path } = call.args
  const target = typeof command === 'string' ? ` · ${command}` : typeof path === 'string' ? ` ${path}` : ''
  const feedback = /dengan arahan: ([^\n]*)/.exec(content)?.[1]
  return `  ${theme.danger('✗')} ${theme.muted(`${title}${target} · ditolak${feedback ? `: ${feedback}` : ''}`)}\n`
}

/**
 * Jawaban pengganti yang ditulis agent — dibatalkan, gagal, berhenti di batas
 * langkah — ditampilkan sebagai baris status seperti saat sesi berjalan, bukan
 * sebagai teks jawaban.
 */
function splitMarker(content: string): { text: string; line: string } {
  const at = content.lastIndexOf('\n\n')
  const text = at === -1 ? '' : content.slice(0, at)
  const tail = at === -1 ? content : content.slice(at + 2)
  if (tail === CANCELLED_REPLY) return { text, line: `  ${theme.danger('✗')} ${theme.muted('Dibatalkan')}\n` }
  if (tail.startsWith(FAILED_REPLY_PREFIX) && tail.endsWith(')')) {
    return { text, line: `\n  ${theme.danger('error')} ${tail.slice(FAILED_REPLY_PREFIX.length, -1)}\n` }
  }
  if (tail.startsWith(TURN_LIMIT_REPLY_PREFIX)) {
    const turns = /^\(Berhenti setelah (\d+)/.exec(tail)?.[1] ?? '?'
    return { text, line: `  ${theme.danger('✗')} ${theme.muted(`berhenti setelah ${turns} langkah`)}\n` }
  }
  return { text: content, line: '' }
}

function renderExchange(exchange: Message[], width: number): string {
  let output = ''
  const tally = new PhaseTally()
  let phase: Phase | null = null
  let recorded = 0
  const calls = new Map<string, PendingCall>()

  const flushPhase = () => {
    if (phase && recorded) output += phaseLine(phase, phase === 'exploring' ? tally.exploring() : tally.applying())
    phase = null
    recorded = 0
    tally.reset()
  }

  for (const message of exchange) {
    if (message.role === 'user') {
      const { note, text } = splitUndoNote(message.content ?? '')
      if (note) output += `  ${theme.accent('↺')} ${theme.muted('perubahan berkas sebelumnya dibatalkan dengan /undo')}\n\n`
      const [first, ...rest] = text.split('\n')
      output += `${theme.accentBold('›')} ${first}\n${rest.map((line) => `  ${line}\n`).join('')}`
      continue
    }

    if (message.role === 'assistant') {
      const { text, line } = splitMarker(message.content ?? '')
      if (text.trim() || line) flushPhase()
      if (text.trim()) {
        const renderer = new MarkdownRenderer({ width })
        output += `\n${renderer.push(text.trimEnd())}${renderer.end()}`
      }
      output += line
      for (const call of message.tool_calls ?? []) {
        calls.set(call.id, { name: call.function.name, args: parseArgs(call.function.arguments) })
      }
      continue
    }

    if (message.role === 'tool') {
      const call = calls.get(message.tool_call_id ?? '')
      if (!call) continue
      const content = message.content ?? ''
      // Tool yang terhenti karena pembatalan tidak dihitung, seperti tampilan langsung.
      if (content.startsWith('Dibatalkan')) continue
      if (content.startsWith('Ditolak oleh pengguna')) {
        flushPhase()
        output += denialLine(call, content)
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
  return output
}

/**
 * Menyusun tampilan ulang percakapan. Mengembalikan teks siap tulis; baris kosong
 * memisahkan setiap tukar-jawab.
 */
export function renderTranscript(messages: Message[], width: number, maxExchanges = MAX_REPLAYED_EXCHANGES): string {
  const exchanges = splitExchanges(messages)
  const shown = exchanges.slice(-maxExchanges)
  const omitted = exchanges.length - shown.length
  const parts = shown.map((exchange) => renderExchange(exchange, width))
  const note = omitted ? `  ${theme.muted(`… ${omitted} tukar-jawab sebelumnya tidak ditampilkan`)}\n\n` : ''
  return note + parts.join('\n')
}
