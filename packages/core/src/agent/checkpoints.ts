/**
 * Titik pemulihan berkas: setiap permintaan pengguna adalah satu checkpoint.
 *
 * Sebelum write_file atau edit_file menyentuh sebuah berkas untuk pertama kalinya
 * dalam satu permintaan, isi aslinya disimpan — atau dicatat bahwa berkas itu belum
 * ada. `/undo` mengembalikan semua berkas dari permintaan terakhir yang mengubah
 * berkas: isinya dipulihkan, berkas baru dihapus beserta folder yang ikut dibuat.
 *
 * Batasnya disengaja dan disampaikan ke pengguna:
 * - perubahan oleh perintah bash (`npm install`, `git checkout`, skrip) tidak
 *   terlihat oleh Boo dan tidak dapat dikembalikan;
 * - berkas yang diubah lagi oleh pengguna setelah Boo mengubahnya ditandai, karena
 *   mengembalikannya ikut membuang perubahan pengguna itu;
 * - checkpoint disimpan di memori, sehingga hilang saat Boo ditutup.
 */

import { createHash } from 'node:crypto'
import { readFile, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { dirname, relative, sep } from 'node:path'
import { diffLines, diffStats } from '../tools/diff.ts'

interface FileRecord {
  absolute: string
  label: string
  /** Isi sebelum permintaan ini menyentuhnya; null berarti berkas belum ada. */
  before: Buffer | null
  /** Folder yang belum ada dan dibuat demi berkas ini, dari yang terdalam. */
  createdDirectories: string[]
  /** Sidik isi terakhir yang ditulis Boo, untuk mengenali perubahan dari luar. */
  afterHash: string | null
}

export interface Checkpoint {
  id: number
  prompt: string
  createdAt: number
  files: Map<string, FileRecord>
  /** Permintaan ini juga menjalankan perintah shell yang mungkin mengubah berkas. */
  ranCommands: boolean
}

export type UndoAction = 'restore' | 'delete'

export interface UndoPlanEntry {
  label: string
  action: UndoAction
  /** Isi berkas berbeda dari yang terakhir ditulis Boo. */
  modifiedSince: boolean
  /** Baris yang bertambah dan berkurang bila dikembalikan. */
  added: number
  removed: number
}

export interface UndoPlan {
  checkpointId: number
  prompt: string
  entries: UndoPlanEntry[]
  ranCommands: boolean
}

function hash(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

async function readOrNull(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

export class Checkpoints {
  private readonly stack: Checkpoint[] = []
  private readonly workspace: string
  private counter = 0

  constructor(workspace: string) {
    this.workspace = workspace
  }

  /** Membuka checkpoint untuk permintaan baru. */
  begin(prompt: string): void {
    this.counter += 1
    this.stack.push({ id: this.counter, prompt, createdAt: Date.now(), files: new Map(), ranCommands: false })
  }

  private get current(): Checkpoint | undefined {
    return this.stack.at(-1)
  }

  /** Dipanggil tool tepat sebelum menulis berkas. */
  async beforeWrite(absolute: string): Promise<void> {
    const checkpoint = this.current
    if (!checkpoint || checkpoint.files.has(absolute)) return
    const before = await readOrNull(absolute)
    const createdDirectories: string[] = []
    if (!before) {
      let directory = dirname(absolute)
      while (directory.startsWith(this.workspace + sep) && !(await exists(directory))) {
        createdDirectories.push(directory)
        directory = dirname(directory)
      }
    }
    checkpoint.files.set(absolute, {
      absolute,
      label: relative(this.workspace, absolute).split(sep).join('/'),
      before,
      createdDirectories,
      afterHash: null,
    })
  }

  /** Dipanggil tool setelah menulis berkas. */
  async afterWrite(absolute: string): Promise<void> {
    const record = this.current?.files.get(absolute)
    if (!record) return
    const after = await readOrNull(absolute)
    record.afterHash = after ? hash(after) : null
  }

  noteCommand(): void {
    if (this.current) this.current.ranCommands = true
  }

  /** Checkpoint terakhir yang benar-benar mengubah berkas. */
  private latest(): Checkpoint | undefined {
    return [...this.stack].reverse().find((checkpoint) => checkpoint.files.size > 0)
  }

  /** Apa yang akan terjadi bila /undo dijalankan sekarang, atau null bila tidak ada. */
  async plan(): Promise<UndoPlan | null> {
    const checkpoint = this.latest()
    if (!checkpoint) return null
    const entries: UndoPlanEntry[] = []
    for (const record of checkpoint.files.values()) {
      const current = await readOrNull(record.absolute)
      const currentHash = current ? hash(current) : null
      // Berkas yang sudah dihapus lagi tidak perlu dihapus; yang sama persis tidak perlu dipulihkan.
      if (!record.before && !current) continue
      if (record.before && current && record.before.equals(current)) continue
      // Baris baru di akhir berkas bukan baris tersendiri.
      const text = (content: Buffer | null) => content?.toString('utf8').replace(/\n$/, '') ?? ''
      const stats = diffStats(diffLines(text(current), text(record.before)))
      entries.push({
        label: record.label,
        action: record.before ? 'restore' : 'delete',
        modifiedSince: currentHash !== record.afterHash,
        added: stats.added,
        removed: stats.removed,
      })
    }
    return { checkpointId: checkpoint.id, prompt: checkpoint.prompt, entries, ranCommands: checkpoint.ranCommands }
  }

  /** Mengembalikan berkas dari checkpoint terakhir yang mengubah berkas, lalu membuangnya. */
  async undo(): Promise<UndoPlan | null> {
    const plan = await this.plan()
    if (!plan) return null
    const index = this.stack.findIndex((checkpoint) => checkpoint.id === plan.checkpointId)
    const checkpoint = this.stack[index]
    for (const record of checkpoint.files.values()) {
      if (record.before) {
        await writeFile(record.absolute, record.before)
        continue
      }
      await rm(record.absolute, { force: true })
      for (const directory of record.createdDirectories) {
        try {
          // Hanya folder yang kosong; berkas lain yang dibuat di sana tetap aman.
          await rmdir(directory)
        } catch {
          break
        }
      }
    }
    this.stack.splice(index, 1)
    return plan
  }
}

/** Catatan untuk model di awal permintaan berikutnya, agar ia tahu berkasnya kembali. */
export const UNDO_NOTE_PREFIX = '[Catatan Boo: pengguna menjalankan /undo.'
const UNDO_NOTE_END = 'sebelum mengubahnya lagi.]'

/** Memisahkan catatan /undo dari pertanyaan yang diketik pengguna. */
export function splitUndoNote(content: string): { note: boolean; text: string } {
  if (!content.startsWith(UNDO_NOTE_PREFIX)) return { note: false, text: content }
  const end = content.lastIndexOf(UNDO_NOTE_END)
  if (end === -1) return { note: false, text: content }
  return { note: true, text: content.slice(end + UNDO_NOTE_END.length).replace(/^\n+/, '') }
}

export function undoNote(plan: UndoPlan): string {
  const restored = plan.entries.filter((entry) => entry.action === 'restore').map((entry) => entry.label)
  const deleted = plan.entries.filter((entry) => entry.action === 'delete').map((entry) => entry.label)
  const parts = [
    restored.length ? `dikembalikan ke isi sebelumnya: ${restored.join(', ')}` : '',
    deleted.length ? `dihapus karena baru dibuat: ${deleted.join(', ')}` : '',
  ].filter(Boolean)
  const prompt = plan.prompt.replace(/\s+/g, ' ').slice(0, 80)
  return `${UNDO_NOTE_PREFIX} Perubahan berkas dari permintaan "${prompt}" dibatalkan — ${parts.join('; ')}. Baca ulang berkas tersebut ${UNDO_NOTE_END}`
}
