/** Penyimpanan hasil tool besar yang dibatasi dan hanya hidup selama satu task. */

import { createHash } from 'node:crypto'

export const TOOL_RESULT_TRUNCATED_MARK = '[BOO TOOL RESULT TRUNCATED]'
export const MAX_VISIBLE_TOOL_RESULT_CHARACTERS = 64_000
export const MAX_TOOL_RESULT_PAGE_CHARACTERS = 60_000
export const MAX_STORED_TOOL_RESULT_CHARACTERS = 2_000_000
export const MAX_TOOL_RESULT_STORE_CHARACTERS = 4_000_000
export const MAX_TOOL_RESULT_ENTRIES = 32
const HEAD_CHARACTERS = 40_000
const TAIL_CHARACTERS = 16_000

interface StoredToolResult {
  tool: string
  content: string
}

export interface PresentedToolResult {
  content: string
  truncated: boolean
  ref?: string
  originalCharacters: number
  visibleCharacters: number
}

export interface ToolResultPage {
  content: string
  isError?: boolean
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback
}

/**
 * Menjaga source besar keluar dari history/context, tetapi tetap menyediakan
 * paging berbasis reference opaque selama request yang sama masih berjalan.
 */
export class ToolResultStore {
  private readonly entries = new Map<string, StoredToolResult>()
  private storedCharacters = 0

  present(tool: string, callId: string, content: string): PresentedToolResult {
    if (content.length <= MAX_VISIBLE_TOOL_RESULT_CHARACTERS) {
      return { content, truncated: false, originalCharacters: content.length, visibleCharacters: content.length }
    }

    let ref: string | undefined
    if (
      content.length <= MAX_STORED_TOOL_RESULT_CHARACTERS
      && this.entries.size < MAX_TOOL_RESULT_ENTRIES
      && this.storedCharacters + content.length <= MAX_TOOL_RESULT_STORE_CHARACTERS
    ) {
      ref = createHash('sha256').update(`${tool}\n${callId}\n${content}`).digest('hex').slice(0, 16)
      if (!this.entries.has(ref)) {
        this.entries.set(ref, { tool, content })
        this.storedCharacters += content.length
      }
    }

    const tailStart = Math.max(HEAD_CHARACTERS, content.length - TAIL_CHARACTERS)
    const retrieval = ref
      ? `Hasil lengkap disimpan sementara di memori sebagai ${ref}. Gunakan read_tool_output dengan ref tersebut, offset 1-based, dan limit maksimal ${MAX_TOOL_RESULT_PAGE_CHARACTERS}. Reference hanya berlaku selama task ini.`
      : `Hasil asli melewati kapasitas penyimpanan task (${MAX_STORED_TOOL_RESULT_CHARACTERS} karakter per hasil, ${MAX_TOOL_RESULT_STORE_CHARACTERS} total); bagian tengah tidak tersedia.`
    const marker = `\n\n${TOOL_RESULT_TRUNCATED_MARK}\nHasil ${tool} berisi ${content.length} karakter. Ditampilkan karakter 1–${HEAD_CHARACTERS} dan ${tailStart + 1}–${content.length}. ${retrieval}\n\n`
    const visible = `${content.slice(0, HEAD_CHARACTERS)}${marker}${content.slice(tailStart)}`
    return {
      content: visible,
      truncated: true,
      ...(ref ? { ref } : {}),
      originalCharacters: content.length,
      visibleCharacters: visible.length,
    }
  }

  read(ref: string, offset?: number, limit?: number): ToolResultPage {
    if (!/^[a-f0-9]{16}$/.test(ref)) return { content: 'Gagal: reference hasil tool tidak valid.', isError: true }
    const entry = this.entries.get(ref)
    if (!entry) return { content: 'Gagal: reference hasil tool tidak tersedia atau berasal dari task yang sudah selesai.', isError: true }
    const start = positiveInteger(offset, 1)
    if (start > Math.max(1, entry.content.length)) {
      return { content: `Gagal: hasil ${entry.tool} hanya ${entry.content.length} karakter; offset ${start} melewati akhir.`, isError: true }
    }
    const size = Math.min(MAX_TOOL_RESULT_PAGE_CHARACTERS, positiveInteger(limit, MAX_TOOL_RESULT_PAGE_CHARACTERS))
    const end = Math.min(entry.content.length, start - 1 + size)
    const page = entry.content.slice(start - 1, end)
    const note = end < entry.content.length
      ? `[Karakter ${start}–${end} dari ${entry.content.length}. Lanjutkan dengan offset ${end + 1}.]`
      : `[Karakter ${start}–${end} dari ${entry.content.length}; akhir hasil ${entry.tool}.]`
    return { content: `${page}\n\n${note}` }
  }
}
