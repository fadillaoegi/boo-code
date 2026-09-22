/**
 * Titik pemulihan berkas: setiap permintaan pengguna adalah satu checkpoint.
 *
 * Sebelum write_file atau edit_file menyentuh sebuah berkas untuk pertama kalinya
 * dalam satu permintaan, isi aslinya disimpan — atau dicatat bahwa berkas itu belum
 * ada. `/undo` mengembalikan permintaan terakhir; `/restore` memilih checkpoint
 * lama dan mengembalikan checkpoint itu beserta seluruh perubahan file sesudahnya.
 *
 * Batasnya disengaja dan disampaikan ke pengguna:
 * - perubahan oleh perintah bash (`npm install`, `git checkout`, skrip) tidak
 *   terlihat oleh Boo dan tidak dapat dikembalikan;
 * - berkas yang diubah lagi oleh pengguna setelah Boo mengubahnya ditandai, karena
 *   mengembalikannya ikut membuang perubahan pengguna itu;
 * - snapshot dapat dipersistenkan per sesi di ~/.boo/checkpoints agar /undo
 *   tetap tersedia setelah restart; tanpa home/sessionId ia tetap memory-only.
 */

import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
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

/** Satu titik yang dapat dipilih lewat `/restore`, terbaru lebih dulu. */
export interface RestorePoint {
  checkpointId: number
  prompt: string
  createdAt: number
  files: number
  ranCommands: boolean
}

/** Metadata minimum untuk melanjutkan run yang terputus; tidak memuat isi file. */
export interface RecoveryCheckpoint {
  checkpointId: number
  createdAt: number
  files: string[]
  ranCommands: boolean
}

/** Gabungan perubahan dari checkpoint terpilih sampai keadaan sekarang. */
export interface RestorePlan extends UndoPlan {
  createdAt: number
  checkpointCount: number
  /** Mendeteksi perubahan file setelah preview tetapi sebelum konfirmasi. */
  fingerprint: string
}

interface RestoreOperation {
  absolute: string
  label: string
  target: Buffer | null
  current: Buffer | null
  expectedAfterHash: string | null
  /** Isi sebelum checkpoint berikutnya berbeda dari hasil Boo sebelumnya. */
  modifiedDuring: boolean
  createdDirectories: string[]
  /** Folder yang dibuat hanya untuk penerapan restore; dibersihkan saat rollback. */
  restoreDirectories: string[]
}

/** Snapshot satu file dalam checkpoint aktif, untuk merge worktree terkontrol. */
export interface CheckpointFileChange {
  label: string
  before: Buffer | null
  after: Buffer | null
}

export const CHECKPOINT_DIRECTORY = 'checkpoints'
const CHECKPOINT_VERSION = 1
const MAX_PERSISTED_CHECKPOINTS = 20
const MAX_CHECKPOINT_BYTES = 64 * 1024 * 1024

interface StoredCheckpoint {
  version: 1
  workspaceId: string
  sessionId: string
  id: number
  prompt: string
  createdAt: number
  ranCommands: boolean
  files: Array<{
    label: string
    before: string | null
    createdDirectories: string[]
    afterHash: string | null
  }>
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
  private readonly storageDirectory: string | null
  private readonly workspaceId: string
  private readonly sessionId: string | null

  constructor(workspace: string, persistence?: { home?: string; sessionId?: string }) {
    this.workspace = resolve(workspace)
    this.workspaceId = createHash('sha256').update(this.workspace).digest('hex').slice(0, 24)
    this.sessionId = persistence?.sessionId ?? null
    this.storageDirectory = persistence?.home && this.sessionId
      ? join(persistence.home, '.boo', CHECKPOINT_DIRECTORY, this.workspaceId, this.sessionId)
      : null
    this.loadPersisted()
  }

  private checkpointPath(id: number): string | null {
    return this.storageDirectory ? join(this.storageDirectory, `${String(id).padStart(10, '0')}.json`) : null
  }

  private safeAbsolute(label: string): string | null {
    if (!label || label.startsWith('/') || label.split(/[\\/]/).includes('..')) return null
    const absolute = resolve(this.workspace, label)
    return absolute.startsWith(`${this.workspace}${sep}`) ? absolute : null
  }

  private loadPersisted(): void {
    if (!this.storageDirectory || !this.sessionId) return
    let names: string[]
    try { names = readdirSync(this.storageDirectory).filter((name) => /^\d+\.json$/.test(name)).sort() } catch { return }
    for (const name of names.slice(-MAX_PERSISTED_CHECKPOINTS)) {
      try {
        const path = join(this.storageDirectory, name)
        const info = statSync(path)
        if (!info.isFile() || info.size > MAX_CHECKPOINT_BYTES) continue
        const stored = JSON.parse(readFileSync(path, 'utf8')) as StoredCheckpoint
        if (stored.version !== CHECKPOINT_VERSION || stored.workspaceId !== this.workspaceId || stored.sessionId !== this.sessionId || !Number.isInteger(stored.id) || !Array.isArray(stored.files)) continue
        const files = new Map<string, FileRecord>()
        for (const file of stored.files) {
          const absolute = this.safeAbsolute(file.label)
          if (!absolute || typeof file.before !== 'string' && file.before !== null || !Array.isArray(file.createdDirectories)) continue
          const createdDirectories = file.createdDirectories.map((label) => this.safeAbsolute(label)).filter((path): path is string => Boolean(path))
          files.set(absolute, {
            absolute,
            label: file.label,
            before: file.before === null ? null : Buffer.from(file.before, 'base64'),
            createdDirectories,
            afterHash: typeof file.afterHash === 'string' ? file.afterHash : null,
          })
        }
        if (!files.size) continue
        this.stack.push({
          id: stored.id,
          prompt: typeof stored.prompt === 'string' ? stored.prompt : '(permintaan sebelumnya)',
          createdAt: Number.isFinite(stored.createdAt) ? stored.createdAt : info.mtimeMs,
          files,
          ranCommands: Boolean(stored.ranCommands),
        })
        this.counter = Math.max(this.counter, stored.id)
      } catch {
        // Snapshot rusak tidak boleh menghalangi agent; checkpoint lain tetap bisa dipakai.
      }
    }
  }

  private persist(checkpoint: Checkpoint): void {
    const target = this.checkpointPath(checkpoint.id)
    if (!target || !this.sessionId || !checkpoint.files.size) return
    const stored: StoredCheckpoint = {
      version: CHECKPOINT_VERSION,
      workspaceId: this.workspaceId,
      sessionId: this.sessionId,
      id: checkpoint.id,
      prompt: checkpoint.prompt.replace(/\s+/g, ' ').slice(0, 500),
      createdAt: checkpoint.createdAt,
      ranCommands: checkpoint.ranCommands,
      files: [...checkpoint.files.values()].map((file) => ({
        label: file.label,
        before: file.before?.toString('base64') ?? null,
        createdDirectories: file.createdDirectories.map((directory) => relative(this.workspace, directory).split(sep).join('/')),
        afterHash: file.afterHash,
      })),
    }
    const serialized = `${JSON.stringify(stored)}\n`
    if (Buffer.byteLength(serialized) > MAX_CHECKPOINT_BYTES) throw new Error('Snapshot perubahan melebihi batas 64 MB; penulisan dibatalkan agar /undo tetap aman.')
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(temporary, serialized, { mode: 0o600, flag: 'wx' })
    renameSync(temporary, target)
    const names = readdirSync(dirname(target)).filter((name) => /^\d+\.json$/.test(name)).sort()
    for (const name of names.slice(0, -MAX_PERSISTED_CHECKPOINTS)) rmSync(join(dirname(target), name), { force: true })
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
    // Harus sudah durable sebelum tool menyentuh file. Bila snapshot gagal,
    // exception menghentikan penulisan dan isi lama tetap aman.
    this.persist(checkpoint)
  }

  /** Dipanggil tool setelah menulis berkas. */
  async afterWrite(absolute: string): Promise<void> {
    const record = this.current?.files.get(absolute)
    if (!record) return
    const after = await readOrNull(absolute)
    record.afterHash = after ? hash(after) : null
    if (this.current) this.persist(this.current)
  }

  noteCommand(): void {
    if (this.current) {
      this.current.ranCommands = true
      this.persist(this.current)
    }
  }

  /** Checkpoint terakhir yang benar-benar mengubah berkas. */
  private latest(): Checkpoint | undefined {
    return [...this.stack].reverse().find((checkpoint) => checkpoint.files.size > 0)
  }

  /** Checkpoint perubahan yang dapat dipilih, terbaru lebih dulu. */
  restorePoints(): RestorePoint[] {
    return this.stack
      .filter((checkpoint) => checkpoint.files.size > 0)
      .map((checkpoint) => ({
        checkpointId: checkpoint.id,
        prompt: checkpoint.prompt,
        createdAt: checkpoint.createdAt,
        files: checkpoint.files.size,
        ranCommands: checkpoint.ranCommands,
      }))
      .reverse()
  }

  /**
   * Snapshot terbaru yang benar-benar menyentuh file sejak run dimulai.
   * Hanya label relatif yang keluar; source lama/baru tetap privat di checkpoint.
   */
  recoverySnapshot(since = 0): RecoveryCheckpoint | null {
    const checkpoint = [...this.stack].reverse().find((candidate) =>
      candidate.files.size > 0 && candidate.createdAt >= since)
    if (!checkpoint) return null
    return {
      checkpointId: checkpoint.id,
      createdAt: checkpoint.createdAt,
      files: [...checkpoint.files.values()].map((file) => file.label).sort(),
      ranCommands: checkpoint.ranCommands,
    }
  }

  /** Restore tidak pernah mengikuti symlink, termasuk symlink yang tetap di workspace. */
  private safeRestoreAbsolute(label: string): string {
    const absolute = this.safeAbsolute(label)
    if (!absolute) throw new Error(`Checkpoint memuat path tidak aman: ${label}`)
    let current = this.workspace
    for (const segment of relative(this.workspace, absolute).split(sep).filter(Boolean)) {
      current = join(current, segment)
      try {
        if (lstatSync(current).isSymbolicLink()) throw new Error(`Restore ditolak karena ${label} melewati symlink.`)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') break
        throw error
      }
    }
    return absolute
  }

  private async restoreState(checkpointId: number): Promise<{ plan: RestorePlan; operations: RestoreOperation[]; checkpoints: Checkpoint[] } | null> {
    const index = this.stack.findIndex((checkpoint) => checkpoint.id === checkpointId && checkpoint.files.size > 0)
    if (index === -1) return null
    const checkpoints = this.stack.slice(index)
    const selected = this.stack[index]
    const targets = new Map<string, RestoreOperation>()

    // Target berasal dari snapshot paling awal; expectedAfterHash diperbarui oleh
    // checkpoint paling baru yang menyentuh file yang sama.
    for (const checkpoint of checkpoints) {
      for (const record of checkpoint.files.values()) {
        const existing = targets.get(record.label)
        if (existing) {
          const beforeHash = record.before ? hash(record.before) : null
          if (beforeHash !== existing.expectedAfterHash) existing.modifiedDuring = true
          existing.expectedAfterHash = record.afterHash
          continue
        }
        const absolute = this.safeRestoreAbsolute(record.label)
        targets.set(record.label, {
          absolute,
          label: record.label,
          target: record.before ? Buffer.from(record.before) : null,
          current: null,
          expectedAfterHash: record.afterHash,
          modifiedDuring: false,
          createdDirectories: [...record.createdDirectories],
          restoreDirectories: [],
        })
      }
    }

    const entries: UndoPlanEntry[] = []
    const fingerprint = createHash('sha256')
    fingerprint.update(checkpoints.map((checkpoint) => checkpoint.id).join(','))
    for (const operation of [...targets.values()].sort((left, right) => left.label.localeCompare(right.label))) {
      operation.current = await readOrNull(operation.absolute)
      const currentHash = operation.current ? hash(operation.current) : null
      const targetHash = operation.target ? hash(operation.target) : null
      fingerprint.update(`\0${operation.label}\0${currentHash ?? '-'}\0${targetHash ?? '-'}`)
      if (operation.target === null ? operation.current === null : operation.current !== null && operation.target.equals(operation.current)) continue
      const text = (content: Buffer | null) => content?.toString('utf8').replace(/\n$/, '') ?? ''
      const stats = diffStats(diffLines(text(operation.current), text(operation.target)))
      entries.push({
        label: operation.label,
        action: operation.target ? 'restore' : 'delete',
        modifiedSince: operation.modifiedDuring || currentHash !== operation.expectedAfterHash,
        added: stats.added,
        removed: stats.removed,
      })
    }
    return {
      plan: {
        checkpointId,
        prompt: selected.prompt,
        createdAt: selected.createdAt,
        checkpointCount: checkpoints.filter((checkpoint) => checkpoint.files.size > 0).length,
        entries,
        ranCommands: checkpoints.some((checkpoint) => checkpoint.ranCommands),
        fingerprint: fingerprint.digest('hex'),
      },
      operations: [...targets.values()],
      checkpoints,
    }
  }

  async planRestore(checkpointId: number): Promise<RestorePlan | null> {
    return (await this.restoreState(checkpointId))?.plan ?? null
  }

  private async atomicWrite(path: string, content: Buffer): Promise<string[]> {
    const createdDirectories: string[] = []
    let directory = dirname(path)
    while (directory.startsWith(`${this.workspace}${sep}`) && !(await exists(directory))) {
      createdDirectories.push(directory)
      directory = dirname(directory)
    }
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.boo-restore-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`
    try {
      await writeFile(temporary, content, { flag: 'wx' })
      await rename(temporary, path)
      return createdDirectories
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      for (const created of createdDirectories) {
        try { await rmdir(created) } catch { break }
      }
      throw error
    }
  }

  /**
   * Mengembalikan checkpoint terpilih dan seluruh checkpoint sesudahnya.
   * Seluruh target dipreflight; bila satu operasi gagal, file yang sudah disentuh
   * dikembalikan ke keadaan saat konfirmasi.
   */
  async restore(checkpointId: number, expectedFingerprint: string): Promise<RestorePlan | null> {
    const state = await this.restoreState(checkpointId)
    if (!state) return null
    if (state.plan.fingerprint !== expectedFingerprint) {
      throw new Error('Workspace berubah setelah pratinjau restore. Tinjau ulang sebelum mencoba lagi.')
    }
    // Semua path diperiksa sebelum file pertama disentuh.
    for (const operation of state.operations) this.safeRestoreAbsolute(operation.label)

    const applied: RestoreOperation[] = []
    try {
      for (const operation of state.operations) {
        this.safeRestoreAbsolute(operation.label)
        const current = await readOrNull(operation.absolute)
        const unchanged = operation.current === null ? current === null : current !== null && operation.current.equals(current)
        if (!unchanged) throw new Error(`Workspace berubah saat restore berjalan: ${operation.label}`)
        const alreadyTarget = operation.target === null ? current === null : current !== null && operation.target.equals(current)
        if (alreadyTarget) continue
        if (operation.target) operation.restoreDirectories = await this.atomicWrite(operation.absolute, operation.target)
        else await rm(operation.absolute, { force: true })
        applied.push(operation)
      }
    } catch (error) {
      const rollbackErrors: string[] = []
      for (const operation of applied.reverse()) {
        try {
          if (operation.current) await this.atomicWrite(operation.absolute, operation.current)
          else {
            await rm(operation.absolute, { force: true })
            for (const directory of operation.restoreDirectories) {
              try { await rmdir(directory) } catch { break }
            }
          }
        } catch {
          rollbackErrors.push(operation.label)
        }
      }
      const suffix = rollbackErrors.length ? ` Rollback gagal untuk: ${rollbackErrors.join(', ')}.` : ' Semua perubahan parsial sudah dibatalkan.'
      throw new Error(`${error instanceof Error ? error.message : 'Restore gagal.'}${suffix}`, { cause: error })
    }

    // Folder yang dahulu dibuat Boo hanya dihapus bila sekarang kosong.
    for (const operation of state.operations) {
      if (operation.target !== null) continue
      for (const directory of operation.createdDirectories) {
        try { await rmdir(directory) } catch { break }
      }
    }
    const ids = new Set(state.checkpoints.map((checkpoint) => checkpoint.id))
    this.stack.splice(this.stack.findIndex((checkpoint) => checkpoint.id === checkpointId))
    for (const id of ids) {
      const persisted = this.checkpointPath(id)
      if (persisted) await rm(persisted, { force: true })
    }
    return state.plan
  }

  /** Menyusun rencana perubahan untuk satu checkpoint tertentu. */
  private async planFor(checkpoint: Checkpoint | undefined): Promise<UndoPlan | null> {
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

  /** Perubahan hanya dari permintaan yang sedang berjalan. */
  async currentPlan(): Promise<UndoPlan | null> {
    return this.planFor(this.current)
  }

  /**
   * Mengambil perubahan checkpoint aktif. Buffer disalin agar pemanggil tidak
   * dapat mengubah snapshot yang dipakai `/undo`.
   */
  async currentChanges(): Promise<CheckpointFileChange[]> {
    const checkpoint = this.current
    if (!checkpoint) return []
    const changes: CheckpointFileChange[] = []
    for (const record of checkpoint.files.values()) {
      const after = await readOrNull(record.absolute)
      if (record.before === null ? after === null : after !== null && record.before.equals(after)) continue
      changes.push({
        label: record.label,
        before: record.before ? Buffer.from(record.before) : null,
        after: after ? Buffer.from(after) : null,
      })
    }
    return changes
  }

  /** Apa yang akan terjadi bila /undo dijalankan sekarang, atau null bila tidak ada. */
  async plan(): Promise<UndoPlan | null> {
    return this.planFor(this.latest())
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
    const persisted = this.checkpointPath(checkpoint.id)
    if (persisted) await rm(persisted, { force: true })
    return plan
  }
}

/** Catatan untuk model di awal permintaan berikutnya, agar ia tahu berkasnya kembali. */
export const UNDO_NOTE_PREFIX = '[Catatan Boo: pengguna menjalankan /undo.'
export const RESTORE_NOTE_PREFIX = '[Catatan Boo: pengguna menjalankan /restore.'
const UNDO_NOTE_END = 'sebelum mengubahnya lagi.]'

/** Memisahkan catatan /undo dari pertanyaan yang diketik pengguna. */
export function splitUndoNote(content: string): { note: boolean; text: string } {
  if (!content.startsWith(UNDO_NOTE_PREFIX) && !content.startsWith(RESTORE_NOTE_PREFIX)) return { note: false, text: content }
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

export function restoreNote(plan: RestorePlan): string {
  const restored = plan.entries.filter((entry) => entry.action === 'restore').map((entry) => entry.label)
  const deleted = plan.entries.filter((entry) => entry.action === 'delete').map((entry) => entry.label)
  const parts = [
    restored.length ? `dikembalikan: ${restored.join(', ')}` : '',
    deleted.length ? `dihapus: ${deleted.join(', ')}` : '',
  ].filter(Boolean)
  const prompt = plan.prompt.replace(/\s+/g, ' ').slice(0, 80)
  return `${RESTORE_NOTE_PREFIX} Workspace dipulihkan ke sebelum permintaan "${prompt}" (${plan.checkpointCount} checkpoint)${parts.length ? ` — ${parts.join('; ')}` : ''}. Riwayat percakapan tidak berubah. Baca ulang berkas terkait ${UNDO_NOTE_END}`
}
