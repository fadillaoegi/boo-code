/**
 * Menempel teks banyak baris ke baris ketik.
 *
 * readline mengirim setiap baris baru sebagai Enter, sehingga log error yang
 * ditempel berubah menjadi belasan permintaan terpisah di antrean. Terminal yang
 * mendukung bracketed paste membungkus tempelan dengan penanda; di antara penanda
 * itu, isinya ditampung utuh. Tempelan banyak baris diwakili satu penanda pendek
 * di baris ketik — seperti Claude Code — dan dikembalikan utuh saat dikirim.
 */

export const ENABLE_BRACKETED_PASTE = `${String.fromCharCode(27)}[?2004h`
export const DISABLE_BRACKETED_PASTE = `${String.fromCharCode(27)}[?2004l`

const PLACEHOLDER = /\[Tempelan #(\d+) · \d+ baris\]/g

/** Bentuk minimal event `keypress` dari Node yang diperlukan oleh input editor. */
export type Keypress = {
  name?: string
  sequence?: string
  meta?: boolean
  shift?: boolean
}

/**
 * Mengidentifikasi Shift+Enter dari terminal yang berbeda-beda.
 *
 * Terminal yang sudah memakai kitty keyboard protocol mengirim `CSI 13;2u`.
 * Sebagian terminal lama mengirim Esc lalu Return (yang Node tandai sebagai
 * Meta+Return), sedangkan Node sendiri memberi `shift: true` untuk beberapa
 * variasi lain. Semua bentuk itu berarti "lanjutkan di baris berikutnya".
 */
export function isShiftEnter(key: Keypress): boolean {
  const nameIsEnter = key.name === 'return' || key.name === 'enter'
  if (nameIsEnter && (key.shift || key.meta)) return true
  return key.sequence === '\u001b[13;2u' || key.sequence === '\u001b[13;2~' || key.sequence === '\u001b[27;2;13~'
}

/**
 * Menyimpan bagian prompt yang dibuat dengan Shift+Enter.
 * `submit` baru mengembalikan nilai ketika Enter biasa ditekan.
 */
export class MultilineInput {
  private readonly lines: string[] = []

  continue(line: string): void {
    this.lines.push(line)
  }

  submit(line: string): string {
    const value = [...this.lines, line].join('\n')
    this.lines.length = 0
    return value
  }

  clear(): void {
    this.lines.length = 0
  }
}

/** Terminal mengirim baris baru tempelan sebagai CR; disamakan menjadi LF. */
export function normalizePaste(raw: string): string {
  return raw.replace(/\r\n?/g, '\n').replace(/\n+$/, '')
}

export class PasteStore {
  private readonly texts: string[] = []

  /** Teks yang disisipkan ke baris ketik untuk sebuah tempelan. */
  insert(raw: string): string {
    const text = normalizePaste(raw)
    if (!text.includes('\n')) return text
    this.texts.push(text)
    return `[Tempelan #${this.texts.length} · ${text.split('\n').length} baris]`
  }

  /** Mengganti penanda tempelan dengan isi aslinya. */
  expand(line: string): string {
    return line.replace(PLACEHOLDER, (placeholder, number: string) => this.texts[Number(number) - 1] ?? placeholder)
  }
}

type KeypressListener = (text: string | undefined, key: { name?: string; sequence?: string } | undefined) => void

/**
 * Memasang penampung tempelan di depan pendengar keypress yang sudah ada (readline).
 * Selama tempelan berlangsung, tombol tidak diteruskan; setelah selesai, `onPaste`
 * menerima seluruh isinya.
 */
export function interceptPaste(input: NodeJS.ReadStream, onPaste: (text: string) => void): void {
  const inner = input.listeners('keypress') as KeypressListener[]
  input.removeAllListeners('keypress')
  let pasting = false
  let buffer = ''
  input.on('keypress', (text: string | undefined, key: { name?: string; sequence?: string } | undefined) => {
    if (key?.name === 'paste-start') {
      pasting = true
      buffer = ''
      return
    }
    if (key?.name === 'paste-end') {
      pasting = false
      onPaste(buffer)
      return
    }
    if (pasting) {
      buffer += key?.sequence ?? text ?? ''
      return
    }
    for (const listener of inner) listener.call(input, text, key)
  })
}
