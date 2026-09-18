/**
 * Parser markdown untuk jawaban Boo di browser.
 *
 * Hasilnya pohon sintaks, bukan HTML. Halaman ini dapat menyetujui perintah shell,
 * jadi teks dari model tidak pernah dimasukkan sebagai HTML: pohon ini diubah
 * menjadi elemen DOM dengan textContent, dan tautan hanya menerima http, https,
 * dan mailto. Jawaban yang berisi `<script>` tampil sebagai teks biasa.
 *
 * Cakupannya yang dipakai model dalam praktik: judul, paragraf, daftar (bertingkat,
 * termasuk checklist), kutipan, blok kode, tabel, garis, dan gaya inline. Jawaban
 * yang masih mengalir diparse ulang utuh; blok kode yang belum ditutup dianggap
 * berlanjut sampai akhir.
 */

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong'; children: Inline[] }
  | { type: 'em'; children: Inline[] }
  | { type: 'del'; children: Inline[] }
  | { type: 'link'; href: string; children: Inline[] }
  | { type: 'break' }

export type Align = 'left' | 'center' | 'right' | null

export interface ListItem {
  /** null bila bukan checklist. */
  checked: boolean | null
  blocks: Block[]
}

export type Block =
  | { type: 'paragraph'; inlines: Inline[] }
  | { type: 'heading'; level: number; inlines: Inline[] }
  | { type: 'code'; language: string; text: string; closed: boolean }
  | { type: 'rule' }
  | { type: 'quote'; blocks: Block[] }
  | { type: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { type: 'table'; align: Align[]; header: Inline[][]; rows: Inline[][][] }

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/
const QUOTE = /^ {0,3}>\s?/
const LIST_ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])\s+(.*)$/
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/

/** Hanya skema yang aman; `javascript:` dan sejenisnya menjadi teks. */
export function safeHref(href: string): string | null {
  const trimmed = href.trim()
  return /^(https?:\/\/|mailto:)/i.test(trimmed) ? trimmed : null
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

function isBlank(line: string): boolean {
  return !line.trim()
}

function splitRow(line: string): string[] {
  let text = line.trim()
  if (text.startsWith('|')) text = text.slice(1)
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1)
  const cells: string[] = []
  let current = ''
  let inCode = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (character === '\\' && text[index + 1] === '|') {
      current += '|'
      index += 1
      continue
    }
    if (character === '`') inCode = !inCode
    if (character === '|' && !inCode) {
      cells.push(current.trim())
      current = ''
      continue
    }
    current += character
  }
  cells.push(current.trim())
  return cells
}

/** Awal sebuah blok selain paragraf; dipakai untuk mengakhiri paragraf. */
function startsBlock(line: string, next: string | undefined): boolean {
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || LIST_ITEM.test(line)
    || (line.includes('|') && next !== undefined && TABLE_SEPARATOR.test(next) && next.includes('-'))
}

export function parseMarkdown(source: string): Block[] {
  return parseBlocks(source.replace(/\r\n?/g, '\n').split('\n'))
}

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]
    if (isBlank(line)) {
      index += 1
      continue
    }

    const fence = FENCE.exec(line)
    if (fence) {
      const marker = fence[1]
      const body: string[] = []
      index += 1
      let closed = false
      while (index < lines.length) {
        const candidate = lines[index].trim()
        if (candidate.startsWith(marker[0].repeat(marker.length)) && /^[`~]+$/.test(candidate)) {
          closed = true
          index += 1
          break
        }
        body.push(lines[index])
        index += 1
      }
      blocks.push({ type: 'code', language: fence[2].toLowerCase(), text: body.join('\n'), closed })
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, inlines: parseInline(heading[2]) })
      index += 1
      continue
    }

    if (RULE.test(line)) {
      blocks.push({ type: 'rule' })
      index += 1
      continue
    }

    if (QUOTE.test(line)) {
      const body: string[] = []
      while (index < lines.length && !isBlank(lines[index]) && (QUOTE.test(lines[index]) || !startsBlock(lines[index], lines[index + 1]))) {
        body.push(lines[index].replace(QUOTE, ''))
        index += 1
      }
      blocks.push({ type: 'quote', blocks: parseBlocks(body) })
      continue
    }

    if (line.includes('|') && index + 1 < lines.length && TABLE_SEPARATOR.test(lines[index + 1]) && lines[index + 1].includes('-')) {
      const header = splitRow(line)
      const align = splitRow(lines[index + 1]).map((cell): Align => {
        const left = cell.startsWith(':')
        const right = cell.endsWith(':')
        return left && right ? 'center' : right ? 'right' : left ? 'left' : null
      })
      index += 2
      const rows: Inline[][][] = []
      while (index < lines.length && !isBlank(lines[index]) && lines[index].includes('|')) {
        const cells = splitRow(lines[index])
        rows.push(header.map((_, column) => parseInline(cells[column] ?? '')))
        index += 1
      }
      blocks.push({ type: 'table', align: header.map((_, column) => align[column] ?? null), header: header.map(parseInline), rows })
      continue
    }

    const item = LIST_ITEM.exec(line)
    if (item) {
      const ordered = /\d/.test(item[2])
      const baseIndent = item[1].length
      const items: ListItem[] = []
      const start = ordered ? Number.parseInt(item[2], 10) : 1
      while (index < lines.length) {
        const current = LIST_ITEM.exec(lines[index])
        if (!current || current[1].length !== baseIndent || /\d/.test(current[2]) !== ordered) break
        const contentIndent = current[1].length + current[2].length + 1
        const body = [current[3]]
        index += 1
        // Baris lanjutan: yang menjorok, atau paragraf yang menyambung tanpa jeda.
        while (index < lines.length) {
          const next = lines[index]
          if (isBlank(next)) {
            const following = lines.slice(index + 1).find((candidate) => !isBlank(candidate))
            if (following !== undefined && indentOf(following) >= Math.min(contentIndent, baseIndent + 2)) {
              body.push('')
              index += 1
              continue
            }
            break
          }
          if (indentOf(next) >= Math.min(contentIndent, baseIndent + 2)) {
            body.push(next.slice(Math.min(indentOf(next), contentIndent)))
            index += 1
            continue
          }
          if (LIST_ITEM.test(next) || startsBlock(next, lines[index + 1])) break
          body.push(next.trim())
          index += 1
        }
        let checked: boolean | null = null
        const task = /^\[([ xX])\]\s+/.exec(body[0])
        if (task) {
          checked = task[1] !== ' '
          body[0] = body[0].slice(task[0].length)
        }
        items.push({ checked, blocks: parseBlocks(body) })
        // Satu baris kosong di antara butir tetap satu daftar.
        if (index < lines.length && isBlank(lines[index])) {
          const following = lines.slice(index + 1).findIndex((candidate) => !isBlank(candidate))
          const nextLine = following === -1 ? undefined : lines[index + 1 + following]
          const nextItem = nextLine === undefined ? null : LIST_ITEM.exec(nextLine)
          if (nextItem && nextItem[1].length === baseIndent && /\d/.test(nextItem[2]) === ordered) {
            index += 1 + following
            continue
          }
          break
        }
      }
      blocks.push({ type: 'list', ordered, start, items })
      continue
    }

    const paragraph: string[] = []
    while (index < lines.length && !isBlank(lines[index]) && (!paragraph.length || !startsBlock(lines[index], lines[index + 1]))) {
      paragraph.push(lines[index].trim())
      index += 1
    }
    blocks.push({ type: 'paragraph', inlines: parseInline(paragraph.join('\n')) })
  }
  return blocks
}

/** Gaya inline. Penanda yang tidak berpasangan tampil apa adanya. */
export function parseInline(text: string): Inline[] {
  const output: Inline[] = []
  let buffer = ''
  const flush = () => {
    if (buffer) output.push({ type: 'text', text: buffer })
    buffer = ''
  }

  let index = 0
  while (index < text.length) {
    const rest = text.slice(index)
    const character = text[index]

    if (character === '\\' && index + 1 < text.length && /[\\`*_~[\]()#|!<>-]/.test(text[index + 1])) {
      buffer += text[index + 1]
      index += 2
      continue
    }

    if (character === '\n') {
      flush()
      output.push({ type: 'break' })
      index += 1
      continue
    }

    if (character === '`') {
      const ticks = /^`+/.exec(rest)![0]
      const end = text.indexOf(ticks, index + ticks.length)
      if (end !== -1) {
        flush()
        output.push({ type: 'code', text: text.slice(index + ticks.length, end).replace(/^ (.+) $/, '$1') })
        index = end + ticks.length
        continue
      }
      buffer += ticks
      index += ticks.length
      continue
    }

    const emphasis = /^(\*\*|__|~~|\*|_)/.exec(rest)
    if (emphasis) {
      const marker = emphasis[1]
      // Garis bawah di tengah kata (nama_variabel) bukan penanda.
      const intraword = marker[0] === '_' && /\w/.test(text[index - 1] ?? '')
      const close = intraword ? -1 : findClosing(text, index + marker.length, marker)
      if (close !== -1 && close > index + marker.length && !/\s/.test(text[index + marker.length])) {
        flush()
        const children = parseInline(text.slice(index + marker.length, close))
        output.push(marker === '~~'
          ? { type: 'del', children }
          : marker.length === 2 ? { type: 'strong', children } : { type: 'em', children })
        index = close + marker.length
        continue
      }
      buffer += marker
      index += marker.length
      continue
    }

    if (character === '[') {
      const link = /^\[([^\]]*)\]\(\s*<?([^()\s>]+(?:\([^()\s]*\))?[^()\s>]*)>?(?:\s+"[^"]*")?\s*\)/.exec(rest)
      if (link) {
        const href = safeHref(link[2])
        flush()
        if (href) output.push({ type: 'link', href, children: parseInline(link[1]) })
        else output.push(...parseInline(link[1]))
        index += link[0].length
        continue
      }
    }

    const autolink = /^https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/.exec(rest)
    if (autolink && !/\w/.test(text[index - 1] ?? '')) {
      flush()
      output.push({ type: 'link', href: autolink[0], children: [{ type: 'text', text: autolink[0] }] })
      index += autolink[0].length
      continue
    }

    buffer += character
    index += 1
  }
  flush()
  return output
}

function findClosing(text: string, from: number, marker: string): number {
  let index = from
  while (index < text.length) {
    if (text[index] === '\\') {
      index += 2
      continue
    }
    if (text[index] === '`') {
      const ticks = /^`+/.exec(text.slice(index))![0]
      const end = text.indexOf(ticks, index + ticks.length)
      index = end === -1 ? index + ticks.length : end + ticks.length
      continue
    }
    if (text.startsWith(marker, index) && !/\s/.test(text[index - 1] ?? '')) {
      // `*` tunggal tidak boleh tertukar dengan `**`.
      if (marker.length === 1 && text[index + 1] === marker) {
        index += 2
        continue
      }
      return index
    }
    index += 1
  }
  return -1
}
