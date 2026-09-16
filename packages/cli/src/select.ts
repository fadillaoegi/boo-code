/**
 * Pemilih daftar dengan tombol panah.
 *
 * Daftar yang tampil bernomor mengundang pengguna menekan panah, jadi panah
 * harus benar-benar bekerja. Selama pemilihan berlangsung, stdin dipindahkan ke
 * raw mode agar setiap penekanan tombol terbaca satu per satu; readline utama
 * dijeda supaya tidak ikut melahap tombol yang sama.
 */

import { emitKeypressEvents, type Interface as ReadlineInterface } from 'node:readline'
import { stdin, stdout } from 'node:process'
import { theme } from './theme.ts'

interface Key {
  name?: string
  ctrl?: boolean
}

export interface SelectOptions {
  items: string[]
  /** Item yang disorot saat pemilih dibuka. */
  activeIndex?: number
  /** Ditampilkan di sebelah kanan item yang sedang dipakai. */
  activeLabel?: string
  hint?: string
}

const CURSOR_HIDE = '[?25l'
const CURSOR_SHOW = '[?25h'
const CLEAR_BELOW = '[0J'

/** Sisakan baris untuk hint dan ruang bernapas di atas serta bawah daftar. */
const CHROME_ROWS = 4
const MIN_VIEWPORT = 5

function viewportSize(itemCount: number): number {
  const available = (stdout.rows || 24) - CHROME_ROWS
  return Math.max(MIN_VIEWPORT, Math.min(itemCount, available))
}

/** Menggeser jendela tampilan supaya kursor selalu terlihat di dalamnya. */
function windowStart(cursor: number, size: number, total: number): number {
  const half = Math.floor(size / 2)
  return Math.max(0, Math.min(cursor - half, total - size))
}

/**
 * Menampilkan pemilih dan mengembalikan item terpilih, atau null bila dibatalkan.
 * Mengembalikan undefined bila terminal tidak mendukung raw mode — pemanggil
 * harus menyediakan jalur cadangan berbasis ketikan.
 */
export function select(
  readline: ReadlineInterface,
  { items, activeIndex = 0, activeLabel = '', hint = '' }: SelectOptions,
): Promise<string | null | undefined> {
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function' || !items.length) {
    return Promise.resolve(undefined)
  }

  return new Promise((resolve) => {
    let cursor = Math.max(0, Math.min(activeIndex, items.length - 1))
    const size = viewportSize(items.length)
    let painted = 0

    const draw = () => {
      // Hapus gambar sebelumnya agar penggambaran ulang terjadi di tempat sama.
      if (painted) stdout.write(`[${painted}A${CLEAR_BELOW}`)

      const start = windowStart(cursor, size, items.length)
      const lines: string[] = []
      for (let index = start; index < start + size; index += 1) {
        const item = items[index]
        const selected = index === cursor
        const marker = selected ? theme.accentBold(' > ') : '   '
        const label = index === activeIndex && activeLabel
          ? `${item} ${theme.muted(activeLabel)}`
          : item
        lines.push(`${marker}${selected ? theme.accent(label) : label}`)
      }
      if (items.length > size) lines.push(theme.muted(`   ${cursor + 1}/${items.length}`))
      if (hint) lines.push(theme.muted(`   ${hint}`))

      stdout.write(`${lines.join('\n')}\n`)
      painted = lines.length
    }

    const finish = (value: string | null) => {
      stdin.off('keypress', onKeypress)
      stdin.setRawMode(false)
      stdout.write(CURSOR_SHOW)
      readline.resume()
      resolve(value)
    }

    const onKeypress = (_: string, key: Key = {}) => {
      if (key.ctrl && key.name === 'c') return finish(null)
      switch (key.name) {
        case 'up':
        case 'k':
          cursor = (cursor - 1 + items.length) % items.length
          return draw()
        case 'down':
        case 'j':
          cursor = (cursor + 1) % items.length
          return draw()
        case 'home':
          cursor = 0
          return draw()
        case 'end':
          cursor = items.length - 1
          return draw()
        case 'return':
          return finish(items[cursor])
        case 'escape':
        case 'q':
          return finish(null)
        default:
          return undefined
      }
    }

    readline.pause()
    emitKeypressEvents(stdin)
    stdin.setRawMode(true)
    stdin.resume()
    stdout.write(CURSOR_HIDE)
    stdin.on('keypress', onKeypress)
    draw()
  })
}
