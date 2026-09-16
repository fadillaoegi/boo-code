/**
 * Menerjemahkan design token Boo menjadi kode warna ANSI untuk terminal.
 *
 * Tokennya sama persis dengan yang dipakai web (packages/core/src/design/tokens.ts),
 * sehingga warna di CLI dan di browser tidak pernah menyimpang.
 */

import { fixedColor, themedColor } from '@boo/core/design/tokens.ts'

/** Terminal modern mendukung warna 24-bit; hex token dipakai apa adanya. */
function fg(hex: string): string {
  const value = hex.replace('#', '')
  const r = parseInt(value.slice(0, 2), 16)
  const g = parseInt(value.slice(2, 4), 16)
  const b = parseInt(value.slice(4, 6), 16)
  return `\x1b[38;2;${r};${g};${b}m`
}

const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'

/** Gaya teks yang dapat digabung; diserialisasi menjadi satu urutan SGR. */
export interface TextStyle {
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  /** Warna depan dalam hex token. */
  color?: string
}

/**
 * Urutan SGR lengkap untuk satu gaya, selalu diawali reset.
 *
 * Mematikan satu atribut terminal dapat ikut mematikan atribut lain — kode 22
 * mematikan tebal sekaligus redup — jadi setiap pergantian gaya menulis ulang
 * seluruh keadaan alih-alih mematikan atribut satu per satu.
 */
export function sgr(style: TextStyle): string {
  const codes = ['0']
  if (style.bold) codes.push('1')
  if (style.dim) codes.push('2')
  if (style.italic) codes.push('3')
  if (style.underline) codes.push('4')
  if (style.strike) codes.push('9')
  let sequence = `\x1b[${codes.join(';')}m`
  if (style.color) sequence += fg(style.color)
  return sequence
}

export const RESET_STYLE = RESET

/** Terminal umumnya berlatar gelap, jadi varian dark yang dipakai. */
const palette = {
  ink: fg(themedColor.ink.dark),
  muted: fg(themedColor.muted.dark),
  accent: fg(fixedColor.accent),
  accentStrong: fg(fixedColor.accentStrong),
  danger: fg(fixedColor.danger),
  added: fg(fixedColor.added),
  removed: fg(fixedColor.removed),
}

function paint(color: string, text: string, bold = false): string {
  return `${bold ? BOLD : ''}${color}${text}${RESET}`
}

export const theme = {
  accent: (text: string) => paint(palette.accent, text),
  accentBold: (text: string) => paint(palette.accentStrong, text, true),
  ink: (text: string) => paint(palette.ink, text),
  muted: (text: string) => `${DIM}${palette.muted}${text}${RESET}`,
  danger: (text: string) => paint(palette.danger, text, true),
  added: (text: string) => paint(palette.added, text),
  removed: (text: string) => paint(palette.removed, text),
  bold: (text: string) => `${BOLD}${text}${RESET}`,
}

/**
 * Banner "BOO CODE". Bagian "BOO" memakai accentStrong dan "CODE" memakai
 * accent, keduanya dari token yang sama dengan web.
 */
const BANNER_LEFT = [
  '██████╗  ██████╗  ██████╗ ',
  '██╔══██╗██╔═══██╗██╔═══██╗',
  '██████╔╝██║   ██║██║   ██║',
  '██╔══██╗██║   ██║██║   ██║',
  '██████╔╝╚██████╔╝╚██████╔╝',
  '╚═════╝  ╚═════╝  ╚═════╝ ',
]

const BANNER_RIGHT = [
  '    ██████╗ ██████╗ ██████╗ ███████╗',
  '   ██╔════╝██╔═══██╗██╔══██╗██╔════╝',
  '   ██║     ██║   ██║██║  ██║█████╗  ',
  '   ██║     ██║   ██║██║  ██║██╔══╝  ',
  '   ╚██████╗╚██████╔╝██████╔╝███████╗',
  '    ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝',
]

/** Lebar penuh banner termasuk indentasi dua spasi. */
const BANNER_COLUMNS = 2 + BANNER_LEFT[0].length + BANNER_RIGHT[0].length

/** Terminal sempit mendapat versi satu baris agar tidak terlipat dan rusak. */
const COMPACT_BANNER = `  ${theme.accentBold('BOO')} ${theme.accent('CODE')}`

export function banner(columns = process.stdout.columns || 80): string {
  if (columns < BANNER_COLUMNS) return COMPACT_BANNER
  return BANNER_LEFT
    .map((line, index) => `  ${theme.accentBold(line)}${theme.accent(BANNER_RIGHT[index])}`)
    .join('\n')
}
