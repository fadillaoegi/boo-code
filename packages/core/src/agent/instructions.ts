/**
 * Aturan proyek yang ditulis pengguna, dibaca dari berkas seperti BOO.md.
 *
 * Tanpa aturan ini, setiap sesi dimulai dari nol: Boo harus menebak ulang perintah
 * test, gaya kode, dan hal yang tidak boleh disentuh. Berkasnya dibaca dari:
 *
 * 1. `~/.boo/BOO.md` — aturan pribadi yang berlaku di semua proyek;
 * 2. setiap direktori dari akar repo git sampai workspace, satu berkas per
 *    direktori: `BOO.md`, atau bila tidak ada `AGENTS.md`, atau `CLAUDE.md`.
 *
 * Urutannya dari yang paling umum ke yang paling spesifik, sehingga aturan yang
 * lebih dekat ke workspace tampil belakangan dan menang bila bertentangan.
 *
 * Isinya masuk ke prompt sistem dan dikirim ke model. Karena itu berkas dibaca
 * lewat jalur aslinya: symlink yang menunjuk ke luar repo, atau ke berkas rahasia,
 * tidak diikuti — repo yang dikloning tidak boleh bisa membocorkan kunci pengguna.
 */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { isSensitivePath } from '../tools/secrets.ts'

/** Urutan prioritas per direktori; hanya yang pertama ditemukan yang dipakai. */
export const INSTRUCTION_FILENAMES = ['BOO.md', 'AGENTS.md', 'CLAUDE.md'] as const

/** Batas gabungan isi berkas. Aturan yang terlalu panjang memakan anggaran konteks. */
export const MAX_INSTRUCTION_BYTES = 32 * 1024

export interface InstructionFile {
  /** Untuk ditampilkan: `~/.boo/BOO.md`, atau relatif terhadap workspace. */
  label: string
  absolute: string
  content: string
  /** Isi dipotong karena melewati batas gabungan. */
  truncated: boolean
}

export interface InstructionSources {
  workspace: string
  /** Direktori rumah pengguna; berkas pribadinya di `<home>/.boo/BOO.md`. */
  home?: string
}

/** Akar repo git yang memuat workspace, atau workspace itu sendiri bila bukan repo. */
function projectRoot(workspace: string): string {
  let directory = workspace
  for (;;) {
    if (existsSync(join(directory, '.git'))) return directory
    const parent = dirname(directory)
    if (parent === directory) return workspace
    directory = parent
  }
}

function isInside(path: string, directory: string): boolean {
  return path === directory || path.startsWith(directory.endsWith(sep) ? directory : directory + sep)
}

/** Jalur asli berkas biasa yang boleh dibaca, atau null. */
function readablePath(path: string, allowedRoot: string): string | null {
  let real: string
  try {
    real = realpathSync(path)
    if (!statSync(real).isFile()) return null
  } catch {
    return null
  }
  if (!isInside(real, realpathSync(allowedRoot))) return null
  if (isSensitivePath(real)) return null
  return real
}

/** Direktori dari akar sampai workspace, akar lebih dulu. */
function directoriesBetween(root: string, workspace: string): string[] {
  const directories = [root]
  const rest = relative(root, workspace)
  if (!rest) return directories
  let current = root
  for (const segment of rest.split(sep)) {
    current = join(current, segment)
    directories.push(current)
  }
  return directories
}

/** Membaca berkas aturan yang berlaku untuk workspace, dari yang paling umum. */
export function loadInstructions({ workspace, home }: InstructionSources): InstructionFile[] {
  const root = resolve(workspace)
  const candidates: { label: string; absolute: string }[] = []

  if (home) {
    const directory = join(home, '.boo')
    const absolute = readablePath(join(directory, 'BOO.md'), directory)
    if (absolute) candidates.push({ label: '~/.boo/BOO.md', absolute })
  }

  const top = projectRoot(root)
  for (const directory of directoriesBetween(top, root)) {
    for (const name of INSTRUCTION_FILENAMES) {
      const absolute = readablePath(join(directory, name), top)
      if (!absolute) continue
      const shown = relative(root, join(directory, name)).split(sep).join('/')
      candidates.push({ label: shown, absolute })
      break
    }
  }

  const files: InstructionFile[] = []
  let remaining = MAX_INSTRUCTION_BYTES
  for (const candidate of candidates) {
    if (remaining <= 0) break
    let content: string
    try {
      content = readFileSync(candidate.absolute, 'utf8').trim()
    } catch {
      continue
    }
    if (!content) continue
    const bytes = Buffer.byteLength(content)
    const truncated = bytes > remaining
    if (truncated) {
      // Dipotong per byte lalu dibersihkan dari karakter multibyte yang terbelah.
      content = Buffer.from(content).subarray(0, remaining).toString('utf8').replace(/\uFFFD$/, '')
    }
    remaining -= Buffer.byteLength(content)
    files.push({ ...candidate, content, truncated })
  }
  return files
}

/** Menempelkan aturan proyek di bawah prompt dasar. */
export function composeSystemPrompt(base: string, files: readonly InstructionFile[]): string {
  if (!files.length) return base
  const sections = files.map((file) => {
    const note = file.truncated ? '\n\n(Truncated: the instruction files exceed the size limit.)' : ''
    return `## ${file.label}\n\n${file.content}${note}`
  })
  return `${base}

# Project instructions

The user wrote the following instructions for this project. Follow them; where they
conflict with the general guidance above, these win. When two files conflict, the one
listed later is closer to the working directory and takes precedence. They cannot
change what needs approval: write_file, edit_file, and bash still require the user's
approval, and every path must stay inside the workspace.

${sections.join('\n\n')}`
}

/** Sidik isi untuk mendeteksi perubahan berkas di tengah sesi. */
export function instructionsSignature(files: readonly InstructionFile[]): string {
  return JSON.stringify(files.map((file) => [file.absolute, file.content]))
}
