/** Penahanan path: seluruh tool wajib lewat sini sebelum menyentuh disk. */

import { lstatSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

export class WorkspaceError extends Error {}

/**
 * Menyelesaikan path relatif terhadap akar workspace dan menolak apa pun yang
 * keluar darinya, termasuk lewat `..` maupun path absolut. Ini satu-satunya
 * penghalang antara agent dan sisa filesystem, jadi jangan dilewati.
 */
export function resolveInWorkspace(workspace: string, path: string): string {
  const logicalRoot = resolve(workspace)
  const target = resolve(logicalRoot, path)
  const rel = relative(logicalRoot, target)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new WorkspaceError(`Path "${path}" berada di luar workspace.`)
  }
  let root: string
  try {
    root = realpathSync(logicalRoot)
  } catch (error) {
    // Beberapa pemanggil memakai root virtual hanya untuk validasi path. Runtime
    // Boo selalu memberi direktori nyata; untuk root virtual pembatas leksikal di
    // atas tetap berlaku, sedangkan pemeriksaan symlink memang tidak relevan.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return target
    throw error
  }
  // Pemeriksaan leksikal saja dapat ditembus oleh symlink. Untuk target yang
  // belum ada, periksa ancestor terdekat yang ada; untuk symlink rusak, tolak.
  let existing = target
  for (;;) {
    try {
      const info = lstatSync(existing)
      let real: string
      try {
        real = realpathSync(existing)
      } catch {
        if (info.isSymbolicLink()) throw new WorkspaceError(`Path "${path}" memakai symlink rusak.`)
        throw new WorkspaceError(`Path "${path}" tidak dapat diselesaikan dengan aman.`)
      }
      const realRelative = relative(root, real)
      if (realRelative.startsWith('..') || isAbsolute(realRelative)) {
        throw new WorkspaceError(`Path "${path}" keluar dari workspace melalui symlink.`)
      }
      break
    } catch (error) {
      if (error instanceof WorkspaceError) throw error
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(existing)
      if (parent === existing || (!parent.startsWith(logicalRoot + sep) && parent !== logicalRoot)) {
        throw new WorkspaceError(`Path "${path}" tidak dapat diselesaikan di dalam workspace.`)
      }
      existing = parent
    }
  }
  return target
}

/** Bentuk singkat untuk ditampilkan ke pengguna. */
export function displayPath(workspace: string, target: string): string {
  return relative(resolve(workspace), target) || '.'
}
