import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { relative, sep } from 'node:path'
import { resolveInWorkspace } from './workspace.ts'

function digest(content: Buffer | null): string | null {
  return content ? createHash('sha256').update(content).digest('hex') : null
}

function signature(path: string): string | null {
  try {
    const info = statSync(path)
    return [info.dev, info.ino, info.mode, info.size, info.mtimeMs, info.ctimeMs].join(':')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function safeLabel(path: string): string {
  return [...path].map((character) => {
    const code = character.charCodeAt(0)
    return code <= 31 || code >= 127 && code <= 159
      ? `\\u${code.toString(16).padStart(4, '0')}`
      : character
  }).join('')
}

async function readOrNull(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

interface Snapshot {
  hash: string | null
  signature: string | null
}

export type ObservedFileChangeKind = 'modified' | 'deleted' | 'unsafe' | 'unreadable'

export interface ObservedFileChange {
  path: string
  kind: ObservedFileChangeKind
}

export const MAX_FRESHNESS_NOTICE_FILES = 20
export const FILE_FRESHNESS_NOTICE_PREFIX = '[Workspace berubah di luar file tools Boo sejak terakhir diamati]'

/** Notice sementara untuk model; tidak memuat isi, hash, atau path absolut. */
export function fileFreshnessPrompt(changes: readonly ObservedFileChange[]): string {
  const shown = changes.slice(0, MAX_FRESHNESS_NOTICE_FILES)
  const kind = (change: ObservedFileChange) => {
    if (change.kind === 'modified') return 'diubah'
    if (change.kind === 'deleted') return 'dihapus'
    if (change.kind === 'unsafe') return 'path menjadi tidak aman'
    return 'tidak dapat dibaca'
  }
  const remaining = changes.length - shown.length
  return [
    FILE_FRESHNESS_NOTICE_PREFIX,
    ...shown.map((change) => `- path ${JSON.stringify(change.path)}: ${kind(change)}`),
    ...(remaining ? [`- … ${remaining} file lain`] : []),
    'Isi file yang pernah ada di riwayat mungkin sudah stale. Baca ulang file terkait sebelum mengandalkannya atau mengubahnya. Pertahankan perubahan eksternal; jangan menimpanya berdasarkan isi lama.',
  ].join('\n')
}

/**
 * Sidik berkas yang pernah dilihat agent. Snapshot bertahan sepanjang sesi agar
 * perubahan dari editor pengguna atau command lain tidak tertimpa diam-diam.
 */
export class FileSnapshots {
  private readonly snapshots = new Map<string, Snapshot>()

  /** Pembacaan eksplisit menjadi sumber kebenaran baru. */
  observe(absolutePath: string, content: Buffer | null): void {
    this.snapshots.set(absolutePath, { hash: digest(content), signature: signature(absolutePath) })
  }

  /**
   * Simpan snapshot bila belum ada. Snapshot lama sengaja tidak diganti: bila
   * isinya berubah, model wajib membaca ulang berkas tersebut lebih dahulu.
   */
  capture(absolutePath: string, content: Buffer | null): void {
    if (!this.snapshots.has(absolutePath)) this.observe(absolutePath, content)
  }

  /** True bila isi sekarang sama dengan versi terakhir yang diketahui agent. */
  matches(absolutePath: string, content: Buffer | null): boolean {
    return !this.snapshots.has(absolutePath) || this.snapshots.get(absolutePath)?.hash === digest(content)
  }

  /**
   * File yang berubah di luar file tools sejak terakhir diamati. Stat murah
   * menyaring file yang tetap sama; isi hanya dibaca dan di-hash bila metadata
   * berubah. Snapshot lama tidak diperbarui sampai isi terbaru dibaca eksplisit.
   */
  async changed(workspace: string): Promise<ObservedFileChange[]> {
    const changes: ObservedFileChange[] = []
    for (const [absolutePath, snapshot] of this.snapshots) {
      const path = relative(workspace, absolutePath).split(sep).join('/')
      const label = safeLabel(path)
      let safePath: string
      try {
        safePath = resolveInWorkspace(workspace, path)
      } catch {
        changes.push({ path: label, kind: 'unsafe' })
        continue
      }
      let currentSignature: string | null
      try {
        currentSignature = signature(safePath)
      } catch {
        changes.push({ path: label, kind: 'unreadable' })
        continue
      }
      if (currentSignature === snapshot.signature) continue
      let current: Buffer | null
      try {
        current = await readOrNull(safePath)
      } catch {
        changes.push({ path: label, kind: 'unreadable' })
        continue
      }
      if (digest(current) === snapshot.hash) {
        // chmod/touch tanpa perubahan isi tidak perlu mengganggu model.
        snapshot.signature = currentSignature
        continue
      }
      changes.push({ path: label, kind: current === null ? 'deleted' : 'modified' })
    }
    return changes.sort((left, right) => left.path.localeCompare(right.path))
  }
}

export const FILE_CHANGED_MESSAGE = (path: string) =>
  `Konflik: ${path} berubah sejak terakhir dibaca. Baca ulang berkas lalu susun perubahan berdasarkan isi terbaru.`
