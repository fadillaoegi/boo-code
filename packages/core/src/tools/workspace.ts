/** Penahanan path: seluruh tool wajib lewat sini sebelum menyentuh disk. */

import { isAbsolute, relative, resolve } from 'node:path'

export class WorkspaceError extends Error {}

/**
 * Menyelesaikan path relatif terhadap akar workspace dan menolak apa pun yang
 * keluar darinya, termasuk lewat `..` maupun path absolut. Ini satu-satunya
 * penghalang antara agent dan sisa filesystem, jadi jangan dilewati.
 */
export function resolveInWorkspace(workspace: string, path: string): string {
  const root = resolve(workspace)
  const target = resolve(root, path)
  const rel = relative(root, target)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new WorkspaceError(`Path "${path}" berada di luar workspace.`)
  }
  return target
}

/** Bentuk singkat untuk ditampilkan ke pengguna. */
export function displayPath(workspace: string, target: string): string {
  return relative(resolve(workspace), target) || '.'
}
