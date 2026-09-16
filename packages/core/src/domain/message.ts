/** Bentuk pesan sesuai format OpenAI chat completions yang dipakai 9Router. */

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool'

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
