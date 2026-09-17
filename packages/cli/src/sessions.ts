/**
 * Penyimpanan sesi percakapan agar dapat dilanjutkan dengan `boo --resume`.
 *
 * Setiap sesi adalah satu berkas JSONL di ~/.boo/sessions. Rekaman ditambahkan
 * baris demi baris secara sinkron begitu pesan masuk ke riwayat, sehingga proses
 * yang berhenti mendadak — Ctrl-C, terminal ditutup, crash — paling banyak
 * kehilangan baris yang sedang ditulis, bukan seluruh percakapan. Baris terakhir
 * yang terpotong dilewati saat dimuat, dan riwayat yang terputus di tengah
 * pemanggilan tool diperbaiki oleh agent.
 *
 * Isi sesi dapat memuat potongan kode dan apa pun yang diketik pengguna, jadi
 * direktori dan berkasnya hanya dapat dibaca pemiliknya.
 */

import { randomUUID } from 'node:crypto'
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { specPromptTitle, splitUndoNote, type Compaction, type Message } from '@boo/core'

export const SESSIONS_DIR = join(homedir(), '.boo', 'sessions')

const FORMAT_VERSION = 1
const TITLE_LENGTH = 60
/** Cukup untuk rekaman pembuka dan pertanyaan pertama saat mendaftar sesi. */
const LIST_PREVIEW_BYTES = 64 * 1024

type SessionRecord =
  | { type: 'session'; version: number; id: string; workspace: string; createdAt: number }
  | { type: 'model'; model: string; reasoningEffort?: string }
  | { type: 'message'; message: Message }
  /** Ringkasan bagian lama; `upTo` dihitung dalam urutan rekaman pesan. */
  | { type: 'compaction'; summary: string; upTo: number }

export interface SessionSummary {
  id: string
  workspace: string
  createdAt: number
  updatedAt: number
  title: string
}

export interface LoadedSession extends SessionSummary {
  messages: Message[]
  model?: string
  reasoningEffort?: string
  /** Ringkasan terakhir, bila konteks sesi ini pernah diringkas. */
  compaction?: Compaction
  /** Baris rusak yang dilewati, biasanya baris terakhir yang terpotong. */
  skippedLines: number
}

export class SessionError extends Error {}

function sessionPath(id: string): string {
  return join(SESSIONS_DIR, `${id}.jsonl`)
}

/** Nama pendek untuk ditampilkan; delapan karakter pertama sudah unik dalam praktik. */
export function shortId(id: string): string {
  return id.slice(0, 8)
}

function titleOf(message: Message | undefined): string {
  const content = splitUndoNote(message?.content ?? '').text
  const text = (specPromptTitle(content) ?? content).replace(/\s+/g, ' ').trim()
  if (!text) return '(tanpa judul)'
  return text.length > TITLE_LENGTH ? `${text.slice(0, TITLE_LENGTH)}…` : text
}

function parseRecords(raw: string): { records: SessionRecord[]; skipped: number } {
  const records: SessionRecord[] = []
  let skipped = 0
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      records.push(JSON.parse(line) as SessionRecord)
    } catch {
      skipped += 1
    }
  }
  return { records, skipped }
}

/**
 * Merekam satu sesi. Berkas baru dibuat saat pesan pertama masuk, supaya
 * membuka `boo` lalu langsung keluar tidak meninggalkan sesi kosong.
 */
export class SessionRecorder {
  readonly id: string
  private readonly workspace: string
  private model: string
  private reasoningEffort: string | undefined
  private created: boolean
  /** Sesi yang dilanjutkan diperiksa ekornya sekali, sebelum rekaman pertama. */
  private tailChecked: boolean

  constructor(options: {
    workspace: string
    model: string
    reasoningEffort?: string
    /** Diisi saat melanjutkan sesi; rekaman baru ditambahkan ke berkas yang sama. */
    resumeId?: string
  }) {
    this.id = options.resumeId ?? randomUUID()
    this.workspace = options.workspace
    this.model = options.model
    this.reasoningEffort = options.reasoningEffort
    this.created = Boolean(options.resumeId)
    this.tailChecked = !options.resumeId
  }

  /** Sesi sudah punya berkas dan karenanya dapat dilanjutkan. */
  get started(): boolean {
    return this.created
  }

  recordMessage(message: Message): void {
    this.ensureCreated()
    this.write({ type: 'message', message })
  }

  recordCompaction(compaction: Compaction): void {
    this.ensureCreated()
    this.write({ type: 'compaction', summary: compaction.summary, upTo: compaction.upTo })
  }

  recordModel(model: string, reasoningEffort: string | undefined): void {
    this.model = model
    this.reasoningEffort = reasoningEffort
    // Sebelum berkas ada, model cukup diingat; ia ditulis bersama rekaman pembuka.
    if (this.created) this.write(this.modelRecord())
  }

  private modelRecord(): SessionRecord {
    return {
      type: 'model',
      model: this.model,
      ...(this.reasoningEffort ? { reasoningEffort: this.reasoningEffort } : {}),
    }
  }

  private ensureCreated(): void {
    if (this.created) return
    mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 })
    this.created = true
    this.write({
      type: 'session',
      version: FORMAT_VERSION,
      id: this.id,
      workspace: this.workspace,
      createdAt: Date.now(),
    })
    this.write(this.modelRecord())
  }

  /** Sinkron, agar urutan terjaga dan rekaman sudah di disk sebelum langkah berikutnya. */
  private write(record: SessionRecord): void {
    if (!this.tailChecked) {
      this.tailChecked = true
      if (!endsWithNewline(sessionPath(this.id))) appendFileSync(sessionPath(this.id), '\n')
    }
    appendFileSync(sessionPath(this.id), `${JSON.stringify(record)}\n`, { mode: 0o600 })
  }
}

/**
 * Proses yang mati di tengah menulis meninggalkan baris terakhir tanpa baris baru.
 * Tanpa pemeriksaan ini, rekaman pertama sesi yang dilanjutkan tertempel pada baris
 * rusak itu dan ikut hilang saat dimuat — pertanyaan pertama setelah crash lenyap.
 */
function endsWithNewline(path: string): boolean {
  let descriptor: number
  try {
    descriptor = openSync(path, 'r')
  } catch {
    return true
  }
  try {
    const { size } = fstatSync(descriptor)
    if (size === 0) return true
    const last = Buffer.alloc(1)
    readSync(descriptor, last, 0, 1, size - 1)
    return last[0] === 0x0a
  } finally {
    closeSync(descriptor)
  }
}

/** Membaca ringkasan tanpa memuat seluruh berkas, yang bisa besar karena isi file. */
function readSummary(id: string): SessionSummary | null {
  const path = sessionPath(id)
  let head: string
  let updatedAt: number
  try {
    updatedAt = statSync(path).mtimeMs
    const descriptor = openSync(path, 'r')
    try {
      const buffer = Buffer.alloc(LIST_PREVIEW_BYTES)
      const bytes = readSync(descriptor, buffer, 0, buffer.length, 0)
      head = buffer.subarray(0, bytes).toString('utf8')
    } finally {
      closeSync(descriptor)
    }
  } catch {
    return null
  }

  const { records } = parseRecords(head)
  const header = records.find((record) => record.type === 'session')
  if (header?.type !== 'session') return null
  const firstQuestion = records.find((record) => record.type === 'message' && record.message.role === 'user')
  return {
    id: header.id,
    workspace: header.workspace,
    createdAt: header.createdAt,
    updatedAt,
    title: titleOf(firstQuestion?.type === 'message' ? firstQuestion.message : undefined),
  }
}

/** Sesi terbaru lebih dulu; bila workspace diberikan, hanya sesi dari direktori itu. */
export function listSessions(workspace?: string): SessionSummary[] {
  let names: string[]
  try {
    names = readdirSync(SESSIONS_DIR)
  } catch {
    return []
  }
  return names
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => readSummary(name.slice(0, -'.jsonl'.length)))
    .filter((summary): summary is SessionSummary => Boolean(summary))
    .filter((summary) => !workspace || summary.workspace === workspace)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/** Menerima id lengkap atau awalannya, seperti yang ditampilkan saat keluar. */
export function resolveSessionId(idOrPrefix: string): string {
  const matches = listSessions().filter((summary) => summary.id.startsWith(idOrPrefix))
  if (!matches.length) throw new SessionError(`Sesi "${idOrPrefix}" tidak ditemukan.`)
  if (matches.length > 1) {
    throw new SessionError(`"${idOrPrefix}" cocok dengan ${matches.length} sesi; tulis id yang lebih panjang.`)
  }
  return matches[0].id
}

export function loadSession(idOrPrefix: string): LoadedSession {
  const id = resolveSessionId(idOrPrefix)
  const path = sessionPath(id)
  const { records, skipped } = parseRecords(readFileSync(path, 'utf8'))

  const header = records.find((record) => record.type === 'session')
  if (header?.type !== 'session') throw new SessionError(`Berkas sesi ${shortId(id)} rusak.`)

  const messages: Message[] = []
  let model: string | undefined
  let reasoningEffort: string | undefined
  let compaction: Compaction | undefined
  for (const record of records) {
    if (record.type === 'message') messages.push(record.message)
    else if (record.type === 'compaction') compaction = { summary: record.summary, upTo: record.upTo }
    else if (record.type === 'model') {
      // Rekaman model terakhir yang berlaku: /model di tengah sesi ikut dipulihkan.
      model = record.model
      reasoningEffort = record.reasoningEffort
    }
  }

  return {
    id,
    workspace: header.workspace,
    createdAt: header.createdAt,
    updatedAt: statSync(path).mtimeMs,
    title: titleOf(messages.find((message) => message.role === 'user')),
    messages,
    model,
    reasoningEffort,
    ...(compaction ? { compaction } : {}),
    skippedLines: skipped,
  }
}

/** "baru saja", "5 menit lalu", "3 jam lalu", "2 hari lalu". */
export function relativeTime(timestamp: number, now = Date.now()): string {
  const minutes = Math.floor((now - timestamp) / 60_000)
  if (minutes < 1) return 'baru saja'
  if (minutes < 60) return `${minutes} menit lalu`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} jam lalu`
  return `${Math.floor(hours / 24)} hari lalu`
}
