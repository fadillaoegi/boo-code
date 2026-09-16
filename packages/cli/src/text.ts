/**
 * Mengukur lebar teks sebagaimana tampil di terminal.
 *
 * Panjang string tidak sama dengan jumlah kolom: kode ANSI tidak memakan kolom,
 * emoji dan aksara CJK memakan dua, dan penanda variasi maupun penggabung emoji
 * tidak memakan sama sekali. Word wrap yang memakai `.length` akan melewati tepi
 * layar begitu jawaban memuat emoji — yang lazim dalam jawaban model.
 */

const ESC = String.fromCharCode(27)
const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, 'g')

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '')
}

/** Rentang yang tampil selebar dua kolom pada terminal umum. */
const WIDE_RANGES: Array<[number, number]> = [
  [0x1100, 0x115f],
  [0x231a, 0x231b],
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f5],
  [0x26fa, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a],
  [0x1f200, 0x1f251],
  [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff],
  [0x1f7e0, 0x1f7eb],
  [0x1f90c, 0x1f9ff],
  [0x1fa70, 0x1faff],
  [0x20000, 0x3fffd],
]

function inRanges(code: number, ranges: Array<[number, number]>): boolean {
  let low = 0
  let high = ranges.length - 1
  while (low <= high) {
    const middle = (low + high) >> 1
    const [start, end] = ranges[middle]
    if (code < start) high = middle - 1
    else if (code > end) low = middle + 1
    else return true
  }
  return false
}

/** Lebar satu titik kode: 0, 1, atau 2 kolom. */
export function codePointWidth(code: number): number {
  if (code === 0x200d || (code >= 0xfe00 && code <= 0xfe0f)) return 0
  if (code >= 0x0300 && code <= 0x036f) return 0
  if (code < 0x20 || (code >= 0x7f && code < 0xa0)) return 0
  return inRanges(code, WIDE_RANGES) ? 2 : 1
}

export function visibleWidth(text: string): number {
  let width = 0
  for (const character of stripAnsi(text)) width += codePointWidth(character.codePointAt(0) ?? 0)
  return width
}
