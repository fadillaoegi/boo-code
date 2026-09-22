/** Kontrak tool. Detail filesystem dan shell berada di lapisan tools/. */

import type { ToolSchema } from './message.ts'
import type { DiffLine } from '../tools/diff.ts'
import type { SandboxPolicy } from '../tools/sandbox.ts'
import type { FileSnapshots } from '../tools/fileSnapshots.ts'

/**
 * `safe`    — hanya membaca, dijalankan tanpa bertanya.
 * `confirm` — mengubah file atau menjalankan perintah, wajib minta izin dulu.
 */
export type ToolRisk = 'safe' | 'confirm'

export interface DelegatedTask {
  id: string
  task: string
}

export interface DelegatedResult {
  id: string
  status: 'completed' | 'failed' | 'cancelled' | 'conflicted'
  content: string
  turns: number
  toolCalls: number
  /** Berkas yang berhasil digabungkan ke workspace utama. */
  changedFiles?: string[]
  /** Berkas yang tidak digabungkan karena workspace utama berubah. */
  conflicts?: string[]
}

export interface UserQuestionOption {
  label: string
  description?: string
}

export interface UserQuestion {
  header?: string
  question: string
  options: UserQuestionOption[]
  allowCustom: boolean
}

export interface UserAnswer {
  selected?: string
  text?: string
  cancelled?: boolean
}

export type UserAsker = (question: UserQuestion) => Promise<UserAnswer>

export interface ToolResultReader {
  read(ref: string, offset?: number, limit?: number): ToolResult
}

export interface ToolContext {
  /** Akar ruang kerja. Tool tidak boleh menyentuh apa pun di luar ini. */
  workspace: string
  /** Home eksplisit untuk resource global Boo; tidak otomatis boleh dibaca tool umum. */
  home?: string
  /** Menyala saat pengguna menghentikan pekerjaan; tool yang lama harus berhenti. */
  signal?: AbortSignal
  /** Menerima keluaran yang mengalir selagi tool berjalan, untuk ditampilkan langsung. */
  onOutput?: (chunk: string) => void
  /** Dipanggil sebelum dan sesudah berkas ditulis, agar perubahannya dapat dibatalkan. */
  checkpoint?: {
    beforeWrite(absolutePath: string): Promise<void>
    afterWrite(absolutePath: string): Promise<void>
  }
  /** Kebijakan OS sandbox untuk command yang dijalankan tool. */
  sandbox?: SandboxPolicy
  /** Mencegah penulisan menimpa perubahan dari editor atau proses lain. */
  fileSnapshots?: FileSnapshots
  /** Menjalankan investigasi sub-agent yang dibatasi oleh agent utama. */
  delegate?: (task: DelegatedTask, maxTurns: number) => Promise<DelegatedResult>
  /** Menjalankan batch sub-agent penulis di Git worktree terisolasi. */
  delegateWrite?: (tasks: DelegatedTask[], maxTurns: number) => Promise<DelegatedResult[]>
  /** Meminta satu keputusan terstruktur dari pengguna melalui antarmuka aktif. */
  askUser?: UserAsker
  /** Paging hasil tool besar yang hanya hidup selama task aktif. */
  toolResults?: ToolResultReader
}

export interface ToolResult {
  content: string
  isError?: boolean
}

export interface Tool<TArgs = Record<string, unknown>> {
  name: string
  description: string
  risk: ToolRisk
  /**
   * Tool baca-saja yang tidak berbagi state mutable boleh dijalankan bersama
   * tool lain dengan flag yang sama. Opt-in eksplisit mencegah tool `safe`
   * interaktif, network, atau discovery dinamis ikut diparalelkan tanpa audit.
   */
  parallelSafe?: boolean
  /**
   * Bila false, pengguna harus memberi persetujuan baru setiap pemanggilan.
   * Dipakai untuk aksi eksternal seperti mengirim pesan.
   */
  allowAlways?: boolean
  /** Tool mengubah berkas workspace dan harus diblokir dalam mode read-only. */
  writesWorkspace?: boolean
  /** Tool pasti menerapkan perubahan source yang memerlukan verifikasi baru. */
  mutatesWorkspace?: boolean
  /** Tool menjalankan proses yang mungkin mengubah berkas di luar file tools. */
  runsCommand?: boolean
  /** Keberhasilan tool merupakan bukti pemeriksaan perubahan terakhir. */
  verifiesWorkspace?: boolean
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
  /** Seluruh tool yang dapat dijalankan runtime, termasuk yang belum diekspos ke model. */
  list(): Tool[]
  get(name: string): Tool | undefined
  /** Hanya skema aktif yang dikirim ke provider pada putaran berikutnya. */
  schemas(): ToolSchema[]
  /** Registry dinamis dapat mengembalikan katalog ke keadaan awal pada task baru. */
  beginTask?(): void
  /** Nama tool yang skemanya sedang aktif; terutama untuk inspeksi dan pengujian. */
  activeNames?(): string[]
}

export function createRegistry(tools: Tool[]): ToolRegistry {
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  return {
    list: () => [...tools],
    get: (name) => byName.get(name),
    schemas: () => tools.map((tool) => tool.schema),
  }
}
