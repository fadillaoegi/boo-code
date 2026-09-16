/**
 * Diff baris untuk pratinjau sebelum meminta izin.
 *
 * Menyetujui "tulis src/app.ts (40 baris)" berarti menyetujui sesuatu yang tidak
 * terlihat. Pratinjau ini membuat persetujuan menjadi keputusan yang berdasar.
 *
 * Implementasinya sengaja ditulis sendiri dan tanpa dependency: keluarannya
 * hanya dibaca manusia, jadi diff minimal yang sempurna tidak diperlukan.
 */

export type DiffLineKind = 'add' | 'remove' | 'context'

export interface DiffLine {
  kind: DiffLineKind
  text: string
}

/** Di atas ambang ini, biaya LCS tidak sepadan untuk sesuatu yang hanya dibaca sekilas. */
const MAX_DIFF_LINES = 2_000
/** Baris konteks di sekitar perubahan. */
const CONTEXT_LINES = 3

/** Panjang awalan baris yang sama persis di kedua sisi. */
function commonPrefix(before: string[], after: string[]): number {
  let index = 0
  while (index < before.length && index < after.length && before[index] === after[index]) index += 1
  return index
}

/** Panjang akhiran yang sama, tanpa menabrak awalan yang sudah dihitung. */
function commonSuffix(before: string[], after: string[], prefix: number): number {
  let index = 0
  while (
    index < before.length - prefix
    && index < after.length - prefix
    && before[before.length - 1 - index] === after[after.length - 1 - index]
  ) index += 1
  return index
}

/** Tabel panjang suburutan sama terpanjang, dipakai menelusuri diff minimal. */
function lcsTable(before: string[], after: string[]): number[][] {
  const table: number[][] = Array.from(
    { length: before.length + 1 },
    () => new Array<number>(after.length + 1).fill(0),
  )
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      table[i][j] = before[i] === after[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }
  return table
}

/**
 * Membandingkan dua teks per baris.
 * Awalan dan akhiran yang sama dipangkas lebih dulu supaya LCS hanya bekerja
 * pada bagian yang benar-benar berubah.
 */
export function diffLines(beforeText: string, afterText: string): DiffLine[] {
  const before = beforeText.length ? beforeText.split('\n') : []
  const after = afterText.length ? afterText.split('\n') : []

  const prefix = commonPrefix(before, after)
  const suffix = commonSuffix(before, after, prefix)
  const beforeCore = before.slice(prefix, before.length - suffix)
  const afterCore = after.slice(prefix, after.length - suffix)

  const lines: DiffLine[] = before.slice(0, prefix).map((text) => ({ kind: 'context', text }))

  if (beforeCore.length > MAX_DIFF_LINES || afterCore.length > MAX_DIFF_LINES) {
    lines.push(
      ...beforeCore.map((text): DiffLine => ({ kind: 'remove', text })),
      ...afterCore.map((text): DiffLine => ({ kind: 'add', text })),
    )
  } else {
    const table = lcsTable(beforeCore, afterCore)
    let i = 0
    let j = 0
    while (i < beforeCore.length && j < afterCore.length) {
      if (beforeCore[i] === afterCore[j]) {
        lines.push({ kind: 'context', text: beforeCore[i] })
        i += 1
        j += 1
      } else if (table[i + 1][j] >= table[i][j + 1]) {
        lines.push({ kind: 'remove', text: beforeCore[i] })
        i += 1
      } else {
        lines.push({ kind: 'add', text: afterCore[j] })
        j += 1
      }
    }
    while (i < beforeCore.length) lines.push({ kind: 'remove', text: beforeCore[i++] })
    while (j < afterCore.length) lines.push({ kind: 'add', text: afterCore[j++] })
  }

  lines.push(...after.slice(after.length - suffix).map((text): DiffLine => ({ kind: 'context', text })))
  return lines
}

/**
 * Membuang baris konteks yang jauh dari perubahan supaya pratinjau tetap ringkas.
 * Bagian yang dilewati diganti satu baris penanda.
 */
export function condense(lines: DiffLine[], context = CONTEXT_LINES): DiffLine[] {
  const keep = new Array<boolean>(lines.length).fill(false)
  lines.forEach((line, index) => {
    if (line.kind === 'context') return
    for (let n = Math.max(0, index - context); n <= Math.min(lines.length - 1, index + context); n += 1) {
      keep[n] = true
    }
  })

  const condensed: DiffLine[] = []
  let skipped = 0
  lines.forEach((line, index) => {
    if (keep[index]) {
      if (skipped) {
        condensed.push({ kind: 'context', text: `… ${skipped} baris tidak berubah …` })
        skipped = 0
      }
      condensed.push(line)
    } else {
      skipped += 1
    }
  })
  if (skipped) condensed.push({ kind: 'context', text: `… ${skipped} baris tidak berubah …` })
  return condensed
}

export interface DiffStats {
  added: number
  removed: number
}

export function diffStats(lines: DiffLine[]): DiffStats {
  return {
    added: lines.filter((line) => line.kind === 'add').length,
    removed: lines.filter((line) => line.kind === 'remove').length,
  }
}
