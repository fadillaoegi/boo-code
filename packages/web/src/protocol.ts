/**
 * Kontrak antara server web lokal dan halaman di browser.
 *
 * Server memegang seluruh keadaan — agent, sesi, antrean, izin — dan mengirim
 * perubahan sebagai event. Halaman hanya menggambar event itu dan mengirim aksi
 * pengguna, sehingga beberapa tab melihat keadaan yang sama dan menutup tab tidak
 * menghentikan pekerjaan.
 *
 * Modul ini tidak mengimpor apa pun dari Node.
 */

import type { ImageAttachment } from '@boo/core'
import type { ViewItem } from '@boo/core/presentation/view.ts'

export type { ImageAttachment, ViewItem }

export interface ModelView {
  mode: 'manual' | 'auto'
  id: string
  effort: string | null
  /** Nama untuk manusia, misalnya "GPT-5.6 Sol · Extra High". */
  label: string
}

export interface StatusView {
  label: string
  detail: string
  startedAt: number
}

export interface DiffRow {
  kind: 'add' | 'remove' | 'context' | 'skip'
  text: string
  oldNumber?: number
  newNumber?: number
  skipped?: number
}

export type QuestionBody =
  | { type: 'diff'; path: string; language: string; added: number; removed: number; rows: DiffRow[]; truncated: number }
  | { type: 'command'; command: string; description: string }
  | { type: 'undo'; entries: { label: string; action: 'restore' | 'delete'; modifiedSince: boolean; added: number; removed: number }[]; ranCommands: boolean }
  | { type: 'text'; text: string }

export interface QuestionOption {
  id: string
  label: string
  tone?: 'primary' | 'danger'
  /** Pilihan ini meminta teks, misalnya arahan saat menolak. */
  input?: { placeholder: string; required: boolean }
}

export interface QuestionView {
  id: string
  /** Judul kartu, misalnya "Ubah berkas". */
  title: string
  /** Subjek tindakan, misalnya path berkas. */
  subject: string
  prompt: string
  body?: QuestionBody
  options: QuestionOption[]
}

export interface SessionView {
  id: string
  title: string
  updatedAt: number
  current: boolean
}

export interface SpecView {
  name: string
  stage: 'requirements' | 'design' | 'tasks' | 'implementing' | 'done'
  done: number
  total: number
}

export interface PromptCommandView {
  name: string
  description: string
  source: 'global' | 'project'
}

export interface Snapshot {
  version: string
  workspace: string
  model: ModelView
  sessionId: string | null
  items: ViewItem[]
  /** Tukar-jawab lama yang tidak dikirim agar halaman tetap ringan. */
  omittedExchanges: number
  busy: boolean
  queue: string[]
  status: StatusView | null
  question: QuestionView | null
  instructions: string[]
  commands: PromptCommandView[]
}

export type ServerEvent =
  | { type: 'snapshot'; snapshot: Snapshot }
  /** Menambah unsur, atau mengganti unsur dengan id yang sama. */
  | { type: 'item'; item: ViewItem; toEnd?: boolean }
  /** Menambah teks ke jawaban yang sedang mengalir. */
  | { type: 'append'; id: string; text: string }
  | { type: 'status'; status: StatusView | null }
  | { type: 'busy'; busy: boolean }
  | { type: 'queue'; queue: string[] }
  | { type: 'question'; question: QuestionView | null }
  | { type: 'model'; model: ModelView }
  /** Sesi baru mendapat id setelah pesan pertamanya tersimpan. */
  | { type: 'session'; sessionId: string }

export interface ModelFamilyView {
  key: string
  label: string
  featured: boolean
  options: { label: string; modelId: string; effort: string | null; current: boolean }[]
}
