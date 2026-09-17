/**
 * Meringkas percakapan lama saat konteks hampir penuh.
 *
 * Pemangkasan (context.ts) membuang pesan lama begitu saja: Boo lupa apa yang
 * diminta di awal sesi, berkas mana yang sudah diubah, dan keputusan yang sudah
 * disepakati. Di sini bagian lama diringkas oleh model menjadi satu catatan, dan
 * catatan itu dikirim di depan pesan yang tersisa. Pemangkasan tetap menjadi jaring
 * pengaman terakhir bila ringkasan gagal atau satu permintaan saja sudah terlalu besar.
 *
 * Riwayat lengkap tidak diubah — sesi tetap menyimpan dan menampilkan semuanya.
 * Yang berubah hanya salinan yang dikirim ke model.
 */

import type { Message } from '../domain/message.ts'
import { estimateMessageTokens } from './context.ts'

export interface Compaction {
  summary: string
  /** Indeks pesan pertama yang tidak diringkas, dalam riwayat tanpa pesan system. */
  upTo: number
}

/** Ringkasan dibuat saat pesan yang dikirim melewati bagian ini dari anggaran. */
export const COMPACT_THRESHOLD = 0.75
/** Pesan terbaru yang dipertahankan utuh sebisa mungkin muat dalam bagian ini. */
export const KEPT_TAIL_SHARE = 0.35
/** Hasil tool panjang dipotong di bahan ringkasan; isinya jarang perlu diingat kata per kata. */
const TOOL_RESULT_CHARACTERS = 1_500

export const SUMMARY_HEADER = '[Ringkasan percakapan sebelumnya — ditulis otomatis karena konteks hampir penuh]'

function tokens(messages: readonly Message[]): number {
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0)
}

/**
 * Titik potong: indeks pesan user sehingga semua sebelum itu diringkas. Selalu di
 * awal sebuah permintaan pengguna, agar hasil tool tidak terpisah dari pemanggilnya.
 * Dipilih yang paling awal yang menyisakan ekor cukup kecil; bila tidak ada, permintaan
 * terakhir saja yang dipertahankan. Null bila tidak ada yang baru untuk diringkas.
 */
export function chooseCut(history: readonly Message[], from: number, budget: number): number | null {
  const candidates = history
    .map((message, index) => (message.role === 'user' && index > from ? index : -1))
    .filter((index) => index > 0)
  if (!candidates.length) return null
  const fitting = candidates.find((index) => tokens(history.slice(index)) <= budget * KEPT_TAIL_SHARE)
  return fitting ?? candidates.at(-1)!
}

/** Menggeser titik potong ke awal permintaan pengguna berikutnya, bila belum tepat di sana. */
export function alignCut(history: readonly Message[], upTo: number): number {
  let index = Math.min(Math.max(0, upTo), history.length)
  while (index < history.length && history[index].role !== 'user') index += 1
  return index
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)} [… ${text.length - limit} karakter dipotong]`
}

/** Bagian percakapan yang akan diringkas, sebagai teks biasa. */
export function renderForSummary(messages: readonly Message[], maxCharacters: number): string {
  const lines: string[] = []
  for (const message of messages) {
    if (message.role === 'user') lines.push(`PENGGUNA:\n${message.content ?? ''}`)
    else if (message.role === 'assistant') {
      if (message.content?.trim()) lines.push(`BOO:\n${message.content}`)
      for (const call of message.tool_calls ?? []) {
        lines.push(`BOO memanggil ${call.function.name}: ${clip(call.function.arguments, 600)}`)
      }
    } else if (message.role === 'tool') {
      lines.push(`HASIL TOOL:\n${clip(message.content ?? '', TOOL_RESULT_CHARACTERS)}`)
    }
  }
  const text = lines.join('\n\n')
  // Bila tetap terlalu panjang, bagian terbaru yang dipertahankan: ia paling menentukan keadaan sekarang.
  return text.length <= maxCharacters ? text : `[… bagian awal dilewati …]\n\n${text.slice(-maxCharacters)}`
}

const SUMMARY_INSTRUCTIONS = `You summarize an earlier part of a coding session between a user and Boo, a coding agent, so the session can continue with less context. The summary replaces those messages entirely; anything missing from it is forgotten.

Write a concise, complete summary with these sections:
1. User requests — every goal and request in order, including the wording of explicit instructions and constraints.
2. Decisions — choices made and the reasons, and anything the user rejected.
3. Files — each file read, created, or changed, with its path and what changed.
4. Commands and results — commands run and results that matter: test outcomes, errors, versions.
5. Current state — what is done, what is in progress, and what remains.

Keep exact file paths, function names, identifiers, and error messages. Do not invent anything that is not in the conversation. Write in the language the user writes in. Output only the summary.`

/** Permintaan ringkasan untuk model, menggabungkan ringkasan sebelumnya bila ada. */
export function summaryRequest(previous: string | undefined, transcript: string): Message[] {
  const earlier = previous ? `Ringkasan bagian yang lebih awal lagi, gabungkan ke ringkasan baru:\n${previous}\n\n` : ''
  return [
    { role: 'system', content: SUMMARY_INSTRUCTIONS },
    { role: 'user', content: `${earlier}Percakapan yang diringkas:\n\n${transcript}` },
  ]
}

/**
 * Pesan yang dikirim setelah ringkasan: bagian lama diganti ringkasan, yang
 * ditempelkan di depan pesan user pertama yang tersisa — dua pesan user berturut-
 * turut ditolak sebagian provider.
 */
export function applyCompaction(history: readonly Message[], compaction: Compaction | null): Message[] {
  if (!compaction) return [...history]
  const kept = history.slice(compaction.upTo)
  const note = `${SUMMARY_HEADER}\n\n${compaction.summary}`
  if (kept[0]?.role !== 'user') return [{ role: 'user', content: note }, ...kept]
  return [{ ...kept[0], content: `${note}\n\n---\n\n${kept[0].content ?? ''}` }, ...kept.slice(1)]
}
