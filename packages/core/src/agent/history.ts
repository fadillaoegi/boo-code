/**
 * Memulihkan riwayat percakapan yang dimuat dari sesi tersimpan.
 *
 * Sesi ditulis pesan demi pesan, sehingga proses yang berhenti mendadak — Ctrl-C,
 * terminal ditutup, atau crash — dapat meninggalkan pesan assistant yang memanggil
 * tool tanpa seluruh hasilnya. API model menolak riwayat seperti itu: setiap
 * `tool_use` wajib punya `tool_result`, dan setiap `tool_result` wajib punya
 * `tool_use` pemanggilnya. Riwayat yang tidak diperbaiki membuat sesi tidak dapat
 * dilanjutkan sama sekali.
 */

import type { Message } from '../domain/message.ts'

export const INTERRUPTED_TOOL_RESULT = 'Tidak dijalankan: sesi berakhir sebelum tool ini selesai.'
export const INTERRUPTED_REPLY = '(Sesi sebelumnya berakhir sebelum permintaan ini sempat dijawab.)'

export interface RepairResult {
  messages: Message[]
  /** Hasil tool pengganti yang ditambahkan untuk panggilan yang terputus. */
  filledToolResults: number
  /** Jawaban pengganti untuk permintaan yang tidak sempat dijawab. */
  filledReplies: number
  /** Hasil tool yatim atau pesan system yang dibuang. */
  droppedMessages: number
}

/**
 * Menyusun ulang riwayat agar sah dikirim ke model.
 * - Pesan system dibuang; agent selalu memakai system prompt versi terbaru.
 * - Panggilan tool tanpa hasil diberi hasil pengganti tepat setelah bloknya.
 * - Hasil tool yang tidak didahului pemanggilnya dibuang.
 * - Permintaan yang tidak sempat dijawab diberi jawaban pengganti. Tanpa itu
 *   pertanyaan berikutnya menjadi pesan user kedua berturut-turut, yang ditolak
 *   sebagian provider.
 */
export function repairHistory(history: Message[]): RepairResult {
  const messages: Message[] = []
  let filledToolResults = 0
  let filledReplies = 0
  let droppedMessages = 0

  for (let index = 0; index < history.length; index += 1) {
    const message = history[index]

    if (message.role === 'system') {
      droppedMessages += 1
      continue
    }

    // Hasil tool hanya sah bila dipungut oleh blok assistant di bawah ini.
    if (message.role === 'tool') {
      droppedMessages += 1
      continue
    }

    // Pesan user tepat setelah pesan user atau hasil tool berarti giliran assistant
    // di antaranya hilang karena sesi terputus. Ini bisa berada di tengah riwayat:
    // jawaban pengganti tidak ditulis ke berkas sesi, jadi sesi yang dilanjutkan
    // lalu dilanjutkan lagi masih menyimpan celah yang sama.
    const previousRole = messages.at(-1)?.role
    if (message.role === 'user' && (previousRole === 'user' || previousRole === 'tool')) {
      messages.push({ role: 'assistant', content: INTERRUPTED_REPLY })
      filledReplies += 1
    }

    messages.push(message)
    const calls = message.role === 'assistant' ? message.tool_calls ?? [] : []
    if (!calls.length) continue

    // Pungut hasil tool yang menyusul blok ini dan memang milik panggilannya.
    const expected = new Set(calls.map((call) => call.id))
    const answered = new Set<string>()
    while (index + 1 < history.length && history[index + 1].role === 'tool') {
      const result = history[index + 1]
      index += 1
      const id = result.tool_call_id ?? ''
      if (expected.has(id) && !answered.has(id)) {
        messages.push(result)
        answered.add(id)
      } else {
        droppedMessages += 1
      }
    }

    for (const call of calls) {
      if (answered.has(call.id)) continue
      messages.push({ role: 'tool', tool_call_id: call.id, content: INTERRUPTED_TOOL_RESULT })
      filledToolResults += 1
    }
  }

  // Tool yang selesai tetapi belum ditanggapi model, atau pertanyaan yang belum
  // dijawab, sama-sama membutuhkan giliran assistant sebelum pertanyaan baru.
  const last = messages.at(-1)
  if (last?.role === 'user' || last?.role === 'tool') {
    messages.push({ role: 'assistant', content: INTERRUPTED_REPLY })
    filledReplies += 1
  }

  return { messages, filledToolResults, filledReplies, droppedMessages }
}
