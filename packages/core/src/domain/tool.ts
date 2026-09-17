/** Kontrak tool. Detail filesystem dan shell berada di lapisan tools/. */

import type { ToolSchema } from './message.ts'
import type { DiffLine } from '../tools/diff.ts'

/**
 * `safe`    — hanya membaca, dijalankan tanpa bertanya.
 * `confirm` — mengubah file atau menjalankan perintah, wajib minta izin dulu.
 */
export type ToolRisk = 'safe' | 'confirm'

export interface ToolContext {
  /** Akar ruang kerja. Tool tidak boleh menyentuh apa pun di luar ini. */
  workspace: string
  /** Menyala saat pengguna menghentikan pekerjaan; tool yang lama harus berhenti. */
  signal?: AbortSignal
}

export interface ToolResult {
  content: string
  isError?: boolean
}

export interface Tool<TArgs = Record<string, unknown>> {
  name: string
  description: string
  risk: ToolRisk
  schema: ToolSchema
  /** Ringkasan satu baris untuk ditampilkan saat meminta izin. */
  preview(args: TArgs): string
  /**
   * Pratinjau rinci perubahan — biasanya diff — yang ditampilkan sebelum
   * pengguna memberi izin. Tool yang tidak mengubah apa pun tidak perlu
   * menyediakannya.
   */
  detail?(args: TArgs, context: ToolContext): Promise<DiffLine[] | null>
  run(args: TArgs, context: ToolContext): Promise<ToolResult>
}

export interface ToolRegistry {
  list(): Tool[]
  get(name: string): Tool | undefined
  schemas(): ToolSchema[]
}

export function createRegistry(tools: Tool[]): ToolRegistry {
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  return {
    list: () => [...tools],
    get: (name) => byName.get(name),
    schemas: () => tools.map((tool) => tool.schema),
  }
}
