/** Bentuk pesan sesuai format OpenAI chat completions yang dipakai 9Router. */

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool'

/** Referensi gambar privat yang disimpan Boo; path sumber asli tidak direkam. */
export interface ImageAttachment {
  id: string
  name: string
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  /** Path relatif di bawah ~/.boo/attachments. */
  ref: string
  bytes: number
}

export interface ToolCall {
  /**
   * Format id berbeda antarprovider (`call_read_file_<ts>_0` pada ag/*,
   * `call_<acak>` pada cx/*). Selalu kembalikan apa adanya, jangan diparsing.
   */
  id: string
  type: 'function'
  function: {
    name: string
    /** JSON dalam bentuk string, bukan objek. */
    arguments: string
  }
}

export interface Message {
  role: MessageRole
  content?: string | null
  /** Hanya pesan user. Provider mengubah referensi ini menjadi image_url. */
  images?: ImageAttachment[]
  /** Penalaran model thinking, terpisah dari content. Bukan balasan kosong. */
  reasoning_content?: string
  tool_calls?: ToolCall[]
  tool_call_id?: string
}

export interface ToolSchema {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, unknown>
      required?: string[]
    }
  }
}
