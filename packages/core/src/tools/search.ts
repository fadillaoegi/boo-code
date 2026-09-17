/**
 * Penelusuran bersama untuk tool glob dan grep.
 *
 * Tanpa pencarian, agent hanya bisa menemukan kode dengan membuka folder satu per
 * satu lalu membaca berkas utuh — lambat, dan cepat menghabiskan anggaran konteks.
 */

import { glob, stat } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve } from 'node:path'

/**
 * Folder hasil build dan dependensi. Isinya jarang relevan, sering sangat besar,
 * dan hanya akan menenggelamkan hasil yang sebenarnya dicari.
 */
export const IGNORED_DIRECTORIES = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit',
  'coverage', '.turbo', '.cache', '.parcel-cache', '.venv', 'venv', '__pycache__',
  'target', 'vendor', '.idea', '.gradle',
])

export function isIgnored(relativePath: string): boolean {
  return relativePath.split(/[\\/]/).some((segment) => IGNORED_DIRECTORIES.has(segment))
}

export interface FoundFile {
  /** Relatif terhadap akar workspace, dengan pemisah `/`. */
  path: string
  absolute: string
  modifiedAt: number
}

/**
 * Menelusuri berkas yang cocok dengan pola di bawah `directory`.
 * Folder yang diabaikan tidak dimasuki sama sekali, bukan disaring belakangan,
 * sehingga node_modules berukuran besar tidak ikut ditelusuri.
 */
export async function findFiles(workspace: string, directory: string, pattern: string): Promise<FoundFile[]> {
  const root = resolve(workspace)
  const found: FoundFile[] = []
  const matches = glob(pattern, {
    cwd: directory,
    exclude: (entry) => IGNORED_DIRECTORIES.has(basename(entry)),
  })
  for await (const entry of matches) {
    const absolute = resolve(directory, entry)
    const path = relative(root, absolute).split('\\').join('/')
    // Pola seperti `../**/*` atau `/etc/*` dapat keluar dari workspace; hasilnya
    // dibuang di sini agar batas workspace tidak jebol lewat pencarian.
    if (path.startsWith('..') || isAbsolute(path)) continue
    if (isIgnored(path)) continue
    try {
      const info = await stat(absolute)
      if (!info.isFile()) continue
      found.push({ path, absolute, modifiedAt: info.mtimeMs })
    } catch {
      // Berkas hilang di tengah penelusuran; lewati saja.
    }
  }
  return found
}
