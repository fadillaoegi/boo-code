/**
 * Panel permintaan izin sebelum Boo mengubah berkas atau menjalankan perintah.
 *
 * Persetujuan hanya bermakna bila yang disetujui terlihat jelas. Panel ini
 * menyebut tindakannya dengan bahasa manusia — "Buat berkas", "Ubah berkas",
 * "Jalankan perintah" — dan menampilkan isinya: diff bernomor baris dengan latar
 * hijau dan merah, atau perintah shell selengkapnya.
 *
 * Modul ini murni: ia hanya menyusun baris siap tulis, sehingga tata letaknya
 * dapat diuji tanpa terminal.
 */

import type { DiffLine, UndoPlan } from '@boo/core'
import { fixedColor, themedColor } from '@boo/core/design/tokens.ts'
import { highlightLine, type StyledRun } from './highlight.ts'
import { serialize } from './markdown.ts'
import type { TextStyle } from './theme.ts'
import { codePointWidth, visibleWidth } from './text.ts'

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

const MUTED: TextStyle = { color: themedColor.muted.dark }
const BORDER: TextStyle = MUTED
const TITLE: TextStyle = { bold: true, color: fixedColor.accent }
const ADDED_MARK: TextStyle = { color: fixedColor.added, background: fixedColor.addedBackground, bold: true }
const REMOVED_MARK: TextStyle = { color: fixedColor.removed, background: fixedColor.removedBackground, bold: true }

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

/* ------------------------------------------------------------------ helpers */

function runsWidth(runs: StyledRun[]): number {
  return runs.reduce((total, run) => total + visibleWidth(run.text), 0)
}

/** Memotong deretan potongan agar muat, dengan elipsis bergaya sama. */
function truncateRuns(runs: StyledRun[], width: number): StyledRun[] {
  if (runsWidth(runs) <= width) return runs
  const output: StyledRun[] = []
  let used = 0
  for (const run of runs) {
    let text = ''
    for (const character of run.text) {
      const size = codePointWidth(character.codePointAt(0) ?? 0)
      if (used + size > width - 1) {
        if (text) output.push({ text, style: run.style })
        output.push({ text: '…', style: run.style })
        return output
      }
      used += size
      text += character
    }
    output.push({ text, style: run.style })
  }
  return output
}

/** Memotong teks dari depan agar ujungnya — nama berkas — tetap terlihat. */
function truncateStart(text: string, width: number): string {
  if (visibleWidth(text) <= width) return text
  const characters = [...text]
  let used = 1
  let start = characters.length
  while (start > 0) {
    const size = codePointWidth(characters[start - 1].codePointAt(0) ?? 0)
    if (used + size > width) break
    used += size
    start -= 1
  }
  return `…${characters.slice(start).join('')}`
}

function withBackground(runs: StyledRun[], background: string | undefined): StyledRun[] {
  if (!background) return runs
  return runs.map((run) => ({ text: run.text, style: { ...run.style, background } }))
}

/* --------------------------------------------------------------------- body */

/**
 * Isi diff: nomor baris, penanda, dan kode yang disorot. Baris yang ditambah atau
 * dihapus diberi latar selebar panel agar perubahan terlihat sekilas.
 */
export function diffBody(lines: DiffLine[], path: string, width: number, maxLines: number): StyledRun[][] {
  const language = languageOf(path)
  const numbers = lines.map((line) => line.kind === 'remove' ? line.oldNumber : line.newNumber)
  const gutter = Math.max(1, ...numbers.map((number) => String(number ?? '').length))
  const shown = lines.length > maxLines ? lines.slice(0, Math.max(1, maxLines - 1)) : lines

  const rows = shown.map((line): StyledRun[] => {
    if (line.skipped) {
      return [{ text: `${' '.repeat(gutter)}   ⋮ ${line.skipped} baris tidak berubah`, style: MUTED }]
    }
    const number = line.kind === 'remove' ? line.oldNumber : line.newNumber
    const background = line.kind === 'add' ? fixedColor.addedBackground
      : line.kind === 'remove' ? fixedColor.removedBackground : undefined
    const mark: StyledRun = line.kind === 'add' ? { text: '+', style: ADDED_MARK }
      : line.kind === 'remove' ? { text: '-', style: REMOVED_MARK } : { text: ' ', style: {} }
    const code = highlightLine(line.text.replace(/\t/g, '  '), language)
    const row = truncateRuns([
      { text: String(number ?? '').padStart(gutter), style: { ...MUTED, ...(background ? { background } : {}) } },
      { text: ' ', style: background ? { background } : {} },
      mark,
      { text: ' ', style: background ? { background } : {} },
      ...withBackground(code, background),
    ], width)
    const fill = width - runsWidth(row)
    if (background && fill > 0) row.push({ text: ' '.repeat(fill), style: { background } })
    return row
  })

  if (lines.length > shown.length) {
    rows.push([{ text: `${' '.repeat(gutter)}   … ${lines.length - shown.length} baris diff lagi`, style: MUTED }])
  }
  return rows
}

/**
 * Isi perintah shell. Tidak pernah dipotong: bagian perintah yang tersembunyi bisa
 * saja bagian yang berbahaya, jadi perintah panjang dibungkus utuh.
 */
/** Isi panel /undo: berkas yang dikembalikan atau dihapus, beserta peringatannya. */
export function undoBody(plan: UndoPlan): StyledRun[][] {
  const rows: StyledRun[][] = []
  const labelWidth = Math.max(...plan.entries.map((entry) => visibleWidth(entry.label)))
  for (const entry of plan.entries) {
    const action: StyledRun = entry.action === 'restore'
      ? { text: '↺ kembalikan  ', style: { color: fixedColor.accent } }
      : { text: '✗ hapus       ', style: { color: fixedColor.removed } }
    const stats: StyledRun[] = [
      { text: `+${entry.added}`, style: { color: fixedColor.added } },
      { text: ' ', style: {} },
      { text: `-${entry.removed}`, style: { color: fixedColor.removed } },
    ]
    rows.push([action, { text: entry.label.padEnd(labelWidth + 2), style: { bold: true } }, ...stats])
    if (entry.modifiedSince) {
      rows.push([{ text: '  ! diubah lagi setelah Boo mengubahnya; perubahan itu ikut hilang', style: { color: fixedColor.danger } }])
    }
  }
  if (plan.ranCommands) {
    rows.push([])
    rows.push([{ text: 'Perubahan oleh perintah bash di permintaan ini tidak ikut dibatalkan.', style: MUTED }])
  }
  return rows
}

export function commandBody(command: string, width: number): StyledRun[][] {
  const rows: StyledRun[][] = []
  const prompt: StyledRun = { text: '$ ', style: MUTED }
  const continuation: StyledRun = { text: '  ', style: {} }
  for (const [index, line] of command.split('\n').entries()) {
    let row: StyledRun[] = [index === 0 ? prompt : continuation]
    let used = 2
    for (const run of highlightLine(line.replace(/\t/g, '  '), 'sh')) {
      let text = ''
      for (const character of run.text) {
        const size = codePointWidth(character.codePointAt(0) ?? 0)
        if (used + size > width) {
          if (text) row.push({ text, style: run.style })
          rows.push(row)
          row = [continuation]
          used = 2
          text = ''
        }
        text += character
        used += size
      }
      if (text) row.push({ text, style: run.style })
    }
    rows.push(row)
  }
  return rows
}

/* -------------------------------------------------------------------- panel */

export interface PanelStats {
  added: number
  removed: number
}

/**
 * Menyusun panel berbingkai dan mengembalikan baris-baris siap tulis.
 * `width` adalah lebar panel termasuk bingkai; setiap baris sama lebarnya.
 */
export function renderPanel(
  request: ApprovalRequest,
  body: StyledRun[][],
  width: number,
  stats?: PanelStats,
  indent = '  ',
): string[] {
  const inner = width - 4
  const border = (text: string): StyledRun => ({ text, style: BORDER })

  const titleText = ` ${request.title} `
  const top: StyledRun[] = [
    border('╭─'),
    { text: titleText, style: TITLE },
    border(`${'─'.repeat(Math.max(0, width - 3 - visibleWidth(titleText)))}╮`),
  ]

  const statRuns: StyledRun[] = stats
    ? [{ text: `+${stats.added}`, style: { color: fixedColor.added } }, { text: ' ', style: {} }, { text: `-${stats.removed}`, style: { color: fixedColor.removed } }]
    : []
  const statWidth = runsWidth(statRuns)
  const subjectWidth = Math.max(0, inner - (statWidth ? statWidth + 2 : 0))
  const subject: StyledRun = { text: truncateStart(request.subject, subjectWidth), style: { bold: true } }

  const frame = (runs: StyledRun[]): StyledRun[] => {
    const content = truncateRuns(runs, inner)
    const fill = inner - runsWidth(content)
    return [border('│ '), ...content, { text: ' '.repeat(Math.max(0, fill)), style: {} }, border(' │')]
  }

  const lines: StyledRun[][] = [top]
  if (request.subject || statRuns.length) {
    // Jarak hanya dibutuhkan untuk mendorong statistik ke kanan; tanpa statistik,
    // jarak tambahan membuat baris melebihi panel dan ujung nama berkas terpotong.
    const gap = statWidth ? Math.max(1, inner - visibleWidth(subject.text) - statWidth) : 0
    lines.push(frame([subject, { text: ' '.repeat(gap), style: {} }, ...statRuns]))
    if (body.length) lines.push(frame([]))
  }
  for (const row of body) lines.push(frame(row))
  lines.push([border(`╰${'─'.repeat(width - 2)}╯`)])

  return lines.map((line) => `${indent}${serialize(line)}`)
}
