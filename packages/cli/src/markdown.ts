/**
 * Merender markdown jawaban model menjadi teks terminal yang rapi.
 *
 * Jawaban tiba sepotong-sepotong, dan konstruksi markdown sering terpotong di
 * tengah — `**teb` lalu `al**`. Seperti Codex, renderer ini baru menampilkan
 * baris yang sudah lengkap, sehingga setiap baris diberi gaya dengan pengetahuan
 * penuh atas isinya: penanda yang tidak ditutup tampil apa adanya, alih-alih
 * membuat sisa jawaban tebal. Blok yang butuh melihat seluruh isinya — tabel —
 * ditahan sampai bloknya berakhir.
 *
 * Renderer tidak menulis ke mana pun; ia mengembalikan teks siap tulis, supaya
 * pemanggil tetap mengendalikan kapan keluaran boleh tampil.
 */

import { fixedColor, themedColor } from '@boo/core/design/tokens.ts'
import { highlightLine, type StyledRun } from './highlight.ts'
import { RESET_STYLE, sgr, type TextStyle } from './theme.ts'
import { codePointWidth, visibleWidth } from './text.ts'

export interface MarkdownOptions {
  /** Kolom terminal yang tersedia, termasuk indentasi. */
  width: number
  indent?: string
}

const MUTED: TextStyle = { color: themedColor.muted.dark }
const STYLE = {
  plain: {} as TextStyle,
  code: { color: fixedColor.inlineCode } as TextStyle,
  link: { color: fixedColor.accent, underline: true } as TextStyle,
  muted: MUTED,
  bold: { bold: true } as TextStyle,
  italic: { italic: true } as TextStyle,
  strike: { strike: true, color: themedColor.muted.dark } as TextStyle,
  h1: { bold: true, color: fixedColor.accentStrong } as TextStyle,
  h2: { bold: true, color: fixedColor.accent } as TextStyle,
  h3: { bold: true } as TextStyle,
  quoteBar: { color: fixedColor.accentStrong } as TextStyle,
  quote: { italic: true } as TextStyle,
  marker: { color: fixedColor.accent } as TextStyle,
  border: MUTED,
}

const BULLETS = ['•', '◦', '▪']
const MAX_RULE = 48

/* ------------------------------------------------------------------ inline */

function merge(base: TextStyle, extra: TextStyle): TextStyle {
  return { ...base, ...extra }
}

function countRun(text: string, index: number, character: string): number {
  let end = index
  while (text[end] === character) end += 1
  return end - index
}

/** Posisi penutup code span: deret backtick dengan panjang persis sama. */
function findCodeClose(text: string, from: number, length: number): number {
  let index = text.indexOf('`', from)
  while (index !== -1) {
    const run = countRun(text, index, '`')
    if (run === length) return index
    index = text.indexOf('`', index + run)
  }
  return -1
}

function isAlphanumeric(character: string | undefined): boolean {
  return Boolean(character && /[\p{L}\p{N}]/u.test(character))
}

function isWhitespace(character: string | undefined): boolean {
  return character === undefined || /\s/.test(character)
}

/** `[label](url)` mulai dari `[`; null bila bukan tautan yang utuh. */
function parseLink(text: string, open: number): { label: string; url: string; end: number } | null {
  let depth = 0
  let index = open
  for (; index < text.length; index += 1) {
    const character = text[index]
    if (character === '\\') {
      index += 1
      continue
    }
    if (character === '`') {
      const run = countRun(text, index, '`')
      const close = findCodeClose(text, index + run, run)
      if (close !== -1) index = close + run - 1
      continue
    }
    if (character === '[') depth += 1
    if (character === ']') {
      depth -= 1
      if (depth === 0) break
    }
  }
  if (depth !== 0 || text[index + 1] !== '(') return null

  let parens = 0
  let close = index + 1
  for (; close < text.length; close += 1) {
    if (text[close] === '(') parens += 1
    if (text[close] === ')') {
      parens -= 1
      if (parens === 0) break
    }
  }
  if (parens !== 0) return null

  const url = text.slice(index + 2, close).trim().replace(/\s+"[^"]*"$/, '')
  return { label: text.slice(open + 1, index), url, end: close + 1 }
}

interface Emphasis {
  marker: string
  style: TextStyle
}

function emphasisCandidates(character: string, run: number): Emphasis[] {
  if (character === '~') return run >= 2 ? [{ marker: '~~', style: STYLE.strike }] : []
  const candidates: Emphasis[] = []
  if (run >= 3) candidates.push({ marker: character.repeat(3), style: { bold: true, italic: true } })
  if (run >= 2) candidates.push({ marker: character.repeat(2), style: STYLE.bold })
  candidates.push({ marker: character, style: STYLE.italic })
  return candidates
}

/**
 * Mencoba membuka penekanan di `index`. Aturan pembuka dan penutup mengikuti
 * CommonMark secara sederhana: pembuka harus diikuti bukan-spasi dan penutup
 * didahului bukan-spasi, sehingga `2 * 3 * 4` tetap apa adanya; garis bawah juga
 * tidak boleh menempel pada huruf, sehingga `nama_variabel_ini` tidak miring.
 */
function parseEmphasis(text: string, index: number, base: TextStyle): { runs: StyledRun[]; end: number } | null {
  const character = text[index]
  const run = countRun(text, index, character)
  const underscore = character === '_'

  for (const { marker, style } of emphasisCandidates(character, run)) {
    const length = marker.length
    if (isWhitespace(text[index + length])) continue
    if (underscore && isAlphanumeric(text[index - 1])) continue

    for (let cursor = index + length + 1; cursor < text.length; cursor += 1) {
      const current = text[cursor]
      if (current === '\\') {
        cursor += 1
        continue
      }
      if (current === '`') {
        const codeRun = countRun(text, cursor, '`')
        const close = findCodeClose(text, cursor + codeRun, codeRun)
        if (close !== -1) cursor = close + codeRun - 1
        continue
      }
      if (!text.startsWith(marker, cursor)) continue
      if (isWhitespace(text[cursor - 1])) continue
      if (underscore && isAlphanumeric(text[cursor + length])) continue
      // Penutup tunggal yang sebenarnya bagian dari penanda lebih panjang
      // (misalnya `*` di dalam `**`) dilewati agar tebal tidak terpotong.
      if (length === 1 && text[cursor + 1] === character) {
        cursor += countRun(text, cursor, character) - 1
        continue
      }
      const inner = text.slice(index + length, cursor)
      return { runs: parseInline(inner, merge(base, style)), end: cursor + length }
    }
  }
  return null
}

/** Mengurai satu baris markdown inline menjadi potongan bergaya. */
export function parseInline(text: string, base: TextStyle = STYLE.plain): StyledRun[] {
  const runs: StyledRun[] = []
  let literal = ''
  const flush = () => {
    if (literal) runs.push({ text: literal, style: base })
    literal = ''
  }

  let index = 0
  while (index < text.length) {
    const character = text[index]

    if (character === '\\' && index + 1 < text.length && /[!-/:-@[-`{-~]/.test(text[index + 1])) {
      literal += text[index + 1]
      index += 2
      continue
    }

    if (character === '`') {
      const run = countRun(text, index, '`')
      const close = findCodeClose(text, index + run, run)
      if (close !== -1) {
        flush()
        let content = text.slice(index + run, close)
        if (content.length > 2 && content.startsWith(' ') && content.endsWith(' ')) content = content.slice(1, -1)
        runs.push({ text: content, style: merge(base, STYLE.code) })
        index = close + run
        continue
      }
      literal += text.slice(index, index + run)
      index += run
      continue
    }

    if (character === '[' || (character === '!' && text[index + 1] === '[')) {
      const link = parseLink(text, character === '!' ? index + 1 : index)
      if (link) {
        flush()
        const label = link.label.trim() || link.url
        runs.push(...parseInline(label, merge(base, STYLE.link)))
        if (link.url && link.url !== label) runs.push({ text: ` (${link.url})`, style: merge(base, STYLE.muted) })
        index = link.end
        continue
      }
    }

    if (character === '<') {
      const autolink = /^<(https?:\/\/[^>\s]+)>/.exec(text.slice(index))
      if (autolink) {
        flush()
        runs.push({ text: autolink[1], style: merge(base, STYLE.link) })
        index += autolink[0].length
        continue
      }
    }

    if (character === 'h' && (index === 0 || /[\s(]/.test(text[index - 1]))) {
      const url = /^https?:\/\/[^\s<>)\]]+/.exec(text.slice(index))?.[0].replace(/[.,;:!?]+$/, '')
      if (url) {
        flush()
        runs.push({ text: url, style: merge(base, STYLE.link) })
        index += url.length
        continue
      }
    }

    if (character === '*' || character === '_' || character === '~') {
      const emphasis = parseEmphasis(text, index, base)
      if (emphasis) {
        flush()
        runs.push(...emphasis.runs)
        index = emphasis.end
        continue
      }
      const run = countRun(text, index, character)
      literal += text.slice(index, index + run)
      index += run
      continue
    }

    literal += character
    index += 1
  }
  flush()
  return runs
}

/* -------------------------------------------------------------------- wrap */

function sameStyle(a: TextStyle, b: TextStyle): boolean {
  return a.bold === b.bold && a.dim === b.dim && a.italic === b.italic
    && a.underline === b.underline && a.strike === b.strike && a.color === b.color
    && a.background === b.background
}

function copyRuns(runs: StyledRun[]): StyledRun[] {
  return runs.map((run) => ({ text: run.text, style: run.style }))
}

function runsWidth(runs: StyledRun[]): number {
  return runs.reduce((total, run) => total + visibleWidth(run.text), 0)
}

function appendRun(line: StyledRun[], run: StyledRun): void {
  if (!run.text) return
  const last = line.at(-1)
  if (last && sameStyle(last.style, run.style)) last.text += run.text
  else line.push({ text: run.text, style: run.style })
}

/** Potongan terpanjang dari awal teks yang muat dalam lebar kolom. */
function sliceToWidth(text: string, width: number): string {
  let used = 0
  let end = 0
  for (const character of text) {
    const size = codePointWidth(character.codePointAt(0) ?? 0)
    if (used + size > width) break
    used += size
    end += character.length
  }
  return text.slice(0, end)
}

/**
 * Word wrap dengan indentasi gantung: baris pertama memakai `first`, baris
 * lanjutan memakai `rest`, sehingga teks lanjutan sejajar dengan awal isinya —
 * bukan jatuh ke kolom 0. Kata yang lebih lebar dari satu baris dipotong paksa.
 */
export function wrapRuns(runs: StyledRun[], width: number, first: StyledRun[], rest: StyledRun[]): StyledRun[][] {
  const lines: StyledRun[][] = []
  let line = copyRuns(first)
  let column = runsWidth(first)
  const restWidth = runsWidth(rest)
  let hasContent = false
  let pendingSpace: StyledRun | null = null

  const breakLine = () => {
    lines.push(line)
    line = copyRuns(rest)
    column = restWidth
    hasContent = false
    pendingSpace = null
  }

  for (const run of runs) {
    for (const part of run.text.split(/(\s+)/)) {
      if (!part) continue
      if (/^\s+$/.test(part)) {
        if (hasContent) pendingSpace = { text: ' ', style: run.style }
        continue
      }

      let word = part
      const wordWidth = visibleWidth(word)
      const spaceWidth = pendingSpace ? 1 : 0
      if (hasContent && column + spaceWidth + wordWidth > width) breakLine()
      else if (pendingSpace) {
        appendRun(line, pendingSpace)
        column += 1
      }
      pendingSpace = null

      while (column + visibleWidth(word) > width) {
        const piece = sliceToWidth(word, width - column)
        if (!piece) break
        appendRun(line, { text: piece, style: run.style })
        word = word.slice(piece.length)
        breakLine()
      }
      appendRun(line, { text: word, style: run.style })
      column += visibleWidth(word)
      hasContent = true
    }
  }
  lines.push(line)
  return lines
}

/** Pembungkus per karakter untuk kode: spasi dipertahankan persis. */
function wrapCharacters(runs: StyledRun[], width: number, prefix: StyledRun[]): StyledRun[][] {
  const lines: StyledRun[][] = []
  let line = copyRuns(prefix)
  const prefixWidth = runsWidth(prefix)
  let column = prefixWidth
  for (const run of runs) {
    for (const character of run.text) {
      const size = codePointWidth(character.codePointAt(0) ?? 0)
      if (column + size > width && column > prefixWidth) {
        lines.push(line)
        line = copyRuns(prefix)
        column = prefixWidth
      }
      appendRun(line, { text: character, style: run.style })
      column += size
    }
  }
  lines.push(line)
  return lines
}

function isPlain(style: TextStyle): boolean {
  return !style.bold && !style.dim && !style.italic && !style.underline && !style.strike && !style.color
    && !style.background
}

/** Menyusun satu baris bergaya menjadi teks ANSI, selalu diakhiri reset. */
export function serialize(line: StyledRun[]): string {
  let output = ''
  let current = RESET_STYLE
  for (const run of line) {
    if (!run.text) continue
    const code = isPlain(run.style) ? RESET_STYLE : sgr(run.style)
    if (code !== current) {
      output += code
      current = code
    }
    output += run.text
  }
  return current === RESET_STYLE ? output : `${output}${RESET_STYLE}`
}

/* ------------------------------------------------------------------- table */

type Alignment = 'left' | 'center' | 'right'

/** Memecah baris tabel pada `|` yang bukan escape dan bukan di dalam code span. */
function splitRow(line: string): string[] {
  const cells: string[] = []
  let current = ''
  let inCode = false
  const text = line.trim()
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (character === '\\' && text[index + 1] === '|') {
      current += '|'
      index += 1
      continue
    }
    if (character === '`') inCode = !inCode
    if (character === '|' && !inCode) {
      cells.push(current)
      current = ''
      continue
    }
    current += character
  }
  cells.push(current)
  if (text.startsWith('|')) cells.shift()
  if (text.endsWith('|') && !text.endsWith('\\|')) cells.pop()
  return cells.map((cell) => cell.trim())
}

function alignmentOf(cell: string): Alignment {
  const left = cell.startsWith(':')
  const right = cell.endsWith(':')
  if (left && right) return 'center'
  return right ? 'right' : 'left'
}

function pad(runs: StyledRun[], width: number, alignment: Alignment): StyledRun[] {
  const gap = Math.max(0, width - runsWidth(runs))
  const left = alignment === 'right' ? gap : alignment === 'center' ? Math.floor(gap / 2) : 0
  const right = gap - left
  return [{ text: ' '.repeat(left), style: STYLE.plain }, ...runs, { text: ' '.repeat(right), style: STYLE.plain }]
}

/* ---------------------------------------------------------------- renderer */

export class MarkdownRenderer {
  private buffer = ''
  private readonly indent: string
  private readonly width: number
  private code: { character: string; length: number; language: string } | null = null
  private table: string[] = []
  private listIndents: number[] = []
  /** Diawali true agar baris kosong di awal jawaban tidak dicetak. */
  private lastBlank = true
  private wroteAny = false

  constructor({ width, indent = '  ' }: MarkdownOptions) {
    this.indent = indent
    this.width = Math.max(24, width)
  }

  /** Masih ada baris yang belum lengkap atau blok yang ditahan. */
  get hasPending(): boolean {
    return this.buffer.length > 0 || this.table.length > 0
  }

  /** Menerima potongan jawaban dan mengembalikan render baris yang sudah lengkap. */
  push(delta: string): string {
    this.buffer += delta
    let output = ''
    let newline = this.buffer.indexOf('\n')
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '')
      this.buffer = this.buffer.slice(newline + 1)
      output += this.renderLine(line)
      newline = this.buffer.indexOf('\n')
    }
    return output
  }

  /** Menyelesaikan baris terakhir serta blok yang masih ditahan atau terbuka. */
  end(): string {
    let output = ''
    if (this.buffer) {
      output += this.renderLine(this.buffer.replace(/\r$/, ''))
      this.buffer = ''
    }
    output += this.flushTable()
    this.code = null
    return output
  }

  private lines(lines: StyledRun[][]): string {
    this.lastBlank = false
    this.wroteAny = true
    return lines.map((line) => `${serialize(line)}\n`).join('')
  }

  /** Baris kosong pemisah sebelum blok besar, bila belum ada. */
  private separate(): string {
    if (!this.wroteAny || this.lastBlank) return ''
    this.lastBlank = true
    return '\n'
  }

  private block(runs: StyledRun[], first: StyledRun[], rest: StyledRun[]): string {
    return this.lines(wrapRuns(runs, this.width, first, rest))
  }

  private renderLine(line: string): string {
    if (this.code) return this.renderCodeLine(line)

    if (/^\s*\|/.test(line)) {
      this.table.push(line)
      return ''
    }
    let output = this.flushTable()

    const fence = /^\s*(`{3,}|~{3,})\s*([^`\s]*)/.exec(line)
    if (fence) {
      this.listIndents = []
      this.code = { character: fence[1][0], length: fence[1].length, language: fence[2] }
      output += this.separate()
      if (fence[2]) output += this.lines([[{ text: this.indent, style: STYLE.plain }, { text: fence[2], style: STYLE.muted }]])
      return output
    }

    if (!line.trim()) {
      if (!this.lastBlank) {
        this.lastBlank = true
        output += '\n'
      }
      return output
    }

    const indent = { text: this.indent, style: STYLE.plain }

    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (heading) {
      this.listIndents = []
      const level = heading[1].length
      const style = level === 1 ? STYLE.h1 : level === 2 ? STYLE.h2 : STYLE.h3
      return output + this.separate() + this.block(parseInline(heading[2], style), [indent], [indent])
    }

    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      this.listIndents = []
      const rule = '─'.repeat(Math.min(MAX_RULE, this.width - visibleWidth(this.indent)))
      return output + this.lines([[indent, { text: rule, style: STYLE.border }]])
    }

    const quote = /^\s{0,3}>\s?(.*)$/.exec(line)
    if (quote) {
      const bar = [indent, { text: '│ ', style: STYLE.quoteBar }]
      return output + this.block(parseInline(quote[1], STYLE.quote), bar, bar)
    }

    const task = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(line)
    const bullet = task ? null : /^(\s*)[-*+]\s+(.*)$/.exec(line)
    const ordered = task || bullet ? null : /^(\s*)(\d{1,9})([.)])\s+(.*)$/.exec(line)
    if (task || bullet || ordered) {
      const leading = (task ?? bullet ?? ordered)![1].length
      const level = this.listLevel(leading)
      const nesting = '  '.repeat(level)
      let marker: string
      let markerStyle = STYLE.marker
      let body: string
      let bodyStyle = STYLE.plain
      if (task) {
        const done = task[2].toLowerCase() === 'x'
        marker = done ? '☑' : '☐'
        if (!done) markerStyle = STYLE.muted
        else bodyStyle = STYLE.muted
        body = task[3]
      } else if (bullet) {
        marker = BULLETS[level % BULLETS.length]
        body = bullet[2]
      } else {
        marker = `${ordered![2]}${ordered![3]}`
        body = ordered![4]
      }
      const first = [
        { text: `${this.indent}${nesting}`, style: STYLE.plain },
        { text: marker, style: markerStyle },
        { text: ' ', style: STYLE.plain },
      ]
      const rest = [{ text: `${this.indent}${nesting}${' '.repeat(visibleWidth(marker) + 1)}`, style: STYLE.plain }]
      return output + this.block(parseInline(body, bodyStyle), first, rest)
    }

    // Baris menjorok di bawah butir daftar adalah lanjutan butir itu.
    if (/^\s+\S/.test(line) && this.listIndents.length) {
      const hanging = `${this.indent}${'  '.repeat(this.listIndents.length - 1)}  `
      const continuation = [{ text: hanging, style: STYLE.plain }]
      return output + this.block(parseInline(line.trim()), continuation, continuation)
    }

    this.listIndents = []
    return output + this.block(parseInline(line.trim()), [indent], [indent])
  }

  /** Tingkat sarang butir daftar, diturunkan dari indentasi relatif antarbutir. */
  private listLevel(spaces: number): number {
    const stack = this.listIndents
    while (stack.length && spaces < stack[stack.length - 1]) stack.pop()
    if (!stack.length || spaces > stack[stack.length - 1]) stack.push(spaces)
    return stack.length - 1
  }

  private renderCodeLine(line: string): string {
    const { character, length, language } = this.code!
    const close = new RegExp(`^\\s*[${character}]{${length},}\\s*$`)
    if (close.test(line)) {
      this.code = null
      return ''
    }
    const gutter = [{ text: this.indent, style: STYLE.plain }, { text: '│ ', style: STYLE.border }]
    const runs = highlightLine(line.replace(/\t/g, '  '), language)
    return this.lines(wrapCharacters(runs, this.width, gutter))
  }

  private flushTable(): string {
    if (!this.table.length) return ''
    const raw = this.table
    this.table = []
    const rows = raw.map(splitRow)
    const separator = rows[1]
    const isTable = rows.length >= 2 && separator.length > 0 && separator.every((cell) => /^:?-+:?$/.test(cell))
    if (!isTable) {
      const indent = [{ text: this.indent, style: STYLE.plain }]
      return raw.map((line) => this.block(parseInline(line.trim()), indent, indent)).join('')
    }

    const header = rows[0]
    const body = rows.slice(2)
    const columns = Math.max(header.length, ...body.map((row) => row.length))
    const alignments = Array.from({ length: columns }, (_, column) => alignmentOf(separator[column] ?? ''))
    const parsed = [header, ...body].map((row, rowIndex) => Array.from({ length: columns }, (_, column) =>
      parseInline(row[column] ?? '', rowIndex === 0 ? STYLE.bold : STYLE.plain)))

    const widths = Array.from({ length: columns }, (_, column) =>
      Math.max(1, ...parsed.map((row) => runsWidth(row[column]))))
    const available = this.width - visibleWidth(this.indent) - (3 * columns + 1)
    // Kolom terlebar dipersempit lebih dulu; isinya dibungkus di dalam kolom.
    while (widths.reduce((sum, width) => sum + width, 0) > available) {
      const widest = widths.indexOf(Math.max(...widths))
      if (widths[widest] <= 3) break
      widths[widest] -= 1
    }

    const indent = { text: this.indent, style: STYLE.plain }
    const border = (left: string, middle: string, right: string): StyledRun[] => [
      indent,
      { text: `${left}${widths.map((width) => '─'.repeat(width + 2)).join(middle)}${right}`, style: STYLE.border },
    ]
    const renderRow = (cells: StyledRun[][]): StyledRun[][] => {
      const wrapped = cells.map((runs, column) => wrapRuns(runs, widths[column], [], []))
      const height = Math.max(...wrapped.map((lines) => lines.length))
      return Array.from({ length: height }, (_, lineIndex) => {
        const line: StyledRun[] = [indent, { text: '│', style: STYLE.border }]
        wrapped.forEach((lines, column) => {
          line.push({ text: ' ', style: STYLE.plain })
          line.push(...pad(lines[lineIndex] ?? [], widths[column], alignments[column]))
          line.push({ text: ' ', style: STYLE.plain }, { text: '│', style: STYLE.border })
        })
        return line
      })
    }

    const bodyRows = parsed.slice(1).map(renderRow)
    // Tanpa pemisah, isi sel yang terbungkus tampak seperti milik baris berikutnya.
    // Pemisah hanya dipakai bila ada yang terbungkus, supaya tabel ringkas tetap ringkas.
    const wrapped = bodyRows.some((lines) => lines.length > 1)
    const bodyLines = bodyRows.flatMap((lines, index) =>
      wrapped && index > 0 ? [border('├', '┼', '┤'), ...lines] : lines)

    const output: StyledRun[][] = [
      border('┌', '┬', '┐'),
      ...renderRow(parsed[0]),
      border('├', '┼', '┤'),
      ...bodyLines,
      border('└', '┴', '┘'),
    ]
    return this.separate() + this.lines(output)
  }
}
