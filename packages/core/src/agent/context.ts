/**
 * Pemangkasan konteks percakapan agent.
 *
 * Riwayat agent tumbuh jauh lebih cepat daripada chat biasa: satu `read_file`
 * menyuntikkan isi file penuh ke dalam percakapan. Tanpa pemangkasan, sesi
 * panjang akan melewati batas konteks model dan gagal.
 *
 * Aturan yang tidak boleh dilanggar saat memangkas:
 * - Pesan system selalu ikut; ia memuat identitas dan cara kerja Boo.
 * - Pesan `tool` tidak boleh menjadi pesan pertama. API menolak hasil tool yang
 *   kehilangan pesan assistant pemanggilnya, jadi titik potong digeser maju
 *   sampai mendarat di pesan non-tool.
 * - Pesan terbaru diprioritaskan; yang dibuang selalu yang paling lama.
 */

import type { Message } from '../domain/message.ts'

/** Perkiraan kasar: satu token kira-kira empat karakter. */
const CHARS_PER_TOKEN = 4
/** Biaya tetap per pesan untuk penanda peran dan pembatas. */
const MESSAGE_OVERHEAD_TOKENS = 8

export const DEFAULT_MAX_CONTEXT_TOKENS = 100_000

export interface TrimResult {
  messages: Message[]
  estimatedTokens: number
  droppedMessages: number
}

export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

export function estimateMessageTokens(message: Message): number {
  const toolCallText = (message.tool_calls ?? [])
    .map((call) => call.function.name + call.function.arguments)
    .join('')
  return MESSAGE_OVERHEAD_TOKENS
    + estimateTextTokens(message.content ?? '')
    + estimateTextTokens(toolCallText)
}

/**
 * Memotong teks yang terlalu panjang, menyisakan bagian awal dan akhir karena
 * keduanya paling sering memuat konteks yang berguna.
 */
function truncateContent(content: string, tokenBudget: number): string {
  const maxCharacters = Math.max(0, tokenBudget * CHARS_PER_TOKEN)
  if (content.length <= maxCharacters) return content

  const marker = '\n\n[… dipotong agar muat dalam konteks …]\n\n'
  if (maxCharacters <= marker.length + 2) return content.slice(0, maxCharacters)
  const available = maxCharacters - marker.length
  const head = Math.ceil(available * 0.7)
  return `${content.slice(0, head)}${marker}${content.slice(-(available - head))}`
}

/**
 * Mengelompokkan pesan menjadi blok yang aman dipotong di antaranya: pesan
 * assistant yang memanggil tool digabung dengan seluruh hasil toolnya.
 */
function toBlocks(messages: Message[]): Message[][] {
  const blocks: Message[][] = []
  for (const message of messages) {
    const previous = blocks.at(-1)
    const continuesBlock = message.role === 'tool'
      && previous
      && previous[0].role === 'assistant'
      && Boolean(previous[0].tool_calls?.length)
    if (continuesBlock) previous.push(message)
    else blocks.push([message])
  }
  return blocks
}

function blockTokens(block: Message[]): number {
  return block.reduce((total, message) => total + estimateMessageTokens(message), 0)
}

/**
 * Menyusutkan satu blok agar muat dalam anggaran dengan memotong isi pesannya.
 * Panggilan tool pada pesan assistant tidak disentuh karena strukturnya wajib
 * tetap utuh; yang dipotong adalah isi teks, terutama hasil tool yang besar.
 */
function shrinkBlock(block: Message[], tokenBudget: number): Message[] {
  const fixed = block.reduce((total, message) => {
    const toolCallText = (message.tool_calls ?? [])
      .map((call) => call.function.name + call.function.arguments)
      .join('')
    return total + MESSAGE_OVERHEAD_TOKENS + estimateTextTokens(toolCallText)
  }, 0)

  const forContent = Math.max(0, tokenBudget - fixed)
  const share = Math.max(1, Math.floor(forContent / block.length))
  return block.map((message) => message.content
    ? { ...message, content: truncateContent(message.content, share) }
    : message)
}

/**
 * Menyusun pesan yang dikirim ke model agar muat dalam anggaran token.
 * Riwayat aslinya tidak diubah — pemangkasan hanya berlaku untuk satu permintaan.
 */
export function trimToBudget(
  messages: Message[],
  maxTokens = DEFAULT_MAX_CONTEXT_TOKENS,
): TrimResult {
  if (!messages.length) return { messages: [], estimatedTokens: 0, droppedMessages: 0 }

  const hasSystem = messages[0].role === 'system'
  const system = hasSystem ? messages[0] : null
  const rest = hasSystem ? messages.slice(1) : messages

  const systemTokens = system ? estimateMessageTokens(system) : 0
  const budget = Math.max(0, maxTokens - systemTokens)
  const blocks = toBlocks(rest)

  let used = 0
  let cut = blocks.length
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const tokens = blockTokens(blocks[index])
    if (used + tokens > budget) break
    used += tokens
    cut = index
  }

  // Blok terakhir pun tidak muat: pertahankan blok itu dan potong isinya, supaya
  // pasangan tool_use dan tool_result tidak pernah terpisah.
  if (cut === blocks.length && blocks.length) {
    const shrunk = shrinkBlock(blocks[blocks.length - 1], budget)
    const dropped = rest.length - shrunk.length
    return {
      messages: system ? [system, ...shrunk] : shrunk,
      estimatedTokens: systemTokens + blockTokens(shrunk),
      droppedMessages: dropped,
    }
  }

  const kept = blocks.slice(cut).flat()
  return {
    messages: system ? [system, ...kept] : kept,
    estimatedTokens: systemTokens + used,
    droppedMessages: rest.length - kept.length,
  }
}
