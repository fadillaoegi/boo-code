/**
 * Menyebut permintaan izin dengan bahasa manusia, untuk panel CLI dan kartu web.
 */

export type ApprovalKind = 'edit' | 'command' | 'other'

export interface ApprovalRequest {
  kind: ApprovalKind
  /** Judul di bingkai atas, misalnya "Buat berkas". */
  title: string
  /** Berkas atau keterangan yang dikenai tindakan. */
  subject: string
  /** Pertanyaan di atas pilihan, misalnya "Buat catatan.md?". */
  question: string
  /** Pilihan kedua: menyetujui dan tidak bertanya lagi untuk tindakan sejenis. */
  allowAlways: string
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: 'ts', tsx: 'tsx', mts: 'ts', cts: 'ts', js: 'js', jsx: 'jsx', mjs: 'js', cjs: 'js',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', swift: 'swift',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cs: 'cs', php: 'php', dart: 'dart', scala: 'scala',
  sh: 'sh', bash: 'sh', zsh: 'sh', sql: 'sql', json: 'json', yml: 'yaml', yaml: 'yaml', toml: 'toml',
}

export function languageOf(path: string): string {
  const extension = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase() ?? ''
  return LANGUAGE_BY_EXTENSION[extension] ?? ''
}

/** Menyebut tindakan tool dengan bahasa manusia. */
export function describeRequest(tool: string, args: Record<string, unknown>, fileExists: boolean): ApprovalRequest {
  const path = typeof args.path === 'string' ? args.path : ''
  switch (tool) {
    case 'write_file':
      return fileExists
        ? { kind: 'edit', title: 'Tulis ulang berkas', subject: path, question: `Tulis ulang ${path}?`, allowAlways: 'Ya, izinkan semua perubahan berkas di sesi ini' }
        : { kind: 'edit', title: 'Buat berkas', subject: path, question: `Buat ${path}?`, allowAlways: 'Ya, izinkan semua perubahan berkas di sesi ini' }
    case 'edit_file':
      return { kind: 'edit', title: 'Ubah berkas', subject: path, question: `Terapkan perubahan ke ${path}?`, allowAlways: 'Ya, izinkan semua perubahan berkas di sesi ini' }
    case 'bash':
      return { kind: 'command', title: args.run_in_background ? 'Jalankan perintah di latar belakang' : 'Jalankan perintah', subject: typeof args.description === 'string' ? args.description : '', question: 'Jalankan perintah ini?', allowAlways: 'Ya, jangan tanya lagi untuk perintah ini di sesi ini' }
    default:
      return { kind: 'other', title: `Izin ${tool}`, subject: path, question: `Izinkan ${tool}?`, allowAlways: `Ya, jangan tanya lagi untuk ${tool} di sesi ini` }
  }
}
