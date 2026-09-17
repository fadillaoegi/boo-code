/**
 * Baris status hidup untuk menggantikan keluaran tool yang mentah.
 *
 * Menampilkan setiap isi file dan daftar direktori membuat terminal penuh
 * ratusan baris yang hampir tidak pernah dibaca. Yang sebenarnya ingin diketahui
 * pengguna hanyalah: Boo sedang apa, dan sudah sejauh mana.
 *
 * Satu baris digambar ulang di tempat selama sebuah fase berjalan, lalu
 * dibekukan menjadi ringkasan ketika fase berganti.
 *
 * Aktivitas seperti Thinking dan Orchestrating tidak pernah dibekukan. Model
 * berpikir di antara setiap pemanggilan tool, sehingga membekukannya akan
 * memenuhi layar dengan baris yang sama berulang-ulang.
 */

import { stdout } from 'node:process'
import { codePointWidth, visibleWidth } from './text.ts'
import { theme } from './theme.ts'

/** Tiga fase yang mencerminkan apa yang benar-benar dikerjakan agent. */
/** Kelompok pekerjaan yang dibekukan menjadi baris ringkasan. */
export type Phase = 'exploring' | 'applying'

export const PHASE_LABEL: Record<Phase, string> = {
  exploring: 'Exploring',
  applying: 'Applying',
}

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const FRAME_MS = 80
const CLEAR_LINE = '\r\u001b[2K'
/** Selebar label terpanjang, "Orchestrating", ditambah jarak. */
const LABEL_WIDTH = 14
/** Waktu berjalan baru ditampilkan setelah ini, agar aktivitas singkat tidak berisik. */
const ELAPSED_AFTER_MS = 1_000

function formatDuration(ms: number): string {
  return ms < 1_000 ? `${ms}ms` : `${(ms / 1_000).toFixed(1)}s`
}

/**
 * Baris ringkasan fase yang membeku, misalnya "● Exploring  3 files  4.1s".
 * Dipakai juga saat menampilkan ulang sesi, agar keduanya tidak pernah berbeda.
 */
export function phaseLine(phase: Phase, summary: string, duration?: string): string {
  const label = PHASE_LABEL[phase].padEnd(LABEL_WIDTH)
  return `  ${theme.accent('●')} ${theme.bold(label)}${summary}${duration ? `  ${theme.muted(duration)}` : ''}\n`
}

/** Memotong teks biasa agar muat dalam lebar kolom, dengan elipsis bila terpotong. */
function truncate(text: string, width: number): string {
  if (width <= 0) return ''
  if (visibleWidth(text) <= width) return text
  let used = 0
  let output = ''
  for (const character of text) {
    const size = codePointWidth(character.codePointAt(0) ?? 0)
    if (used + size > width - 1) break
    used += size
    output += character
  }
  return `${output}…`
}

/**
 * Menggambar satu baris status yang diperbarui di tempat.
 *
 * Dua hal dipisahkan dengan sengaja:
 * - label hidup: apa yang sedang dikerjakan saat ini — Thinking, Reading,
 *   Writing, dan seterusnya. Berganti sesering pekerjaannya berganti.
 * - fase: kelompok pekerjaan yang dibekukan menjadi baris ringkasan, misalnya
 *   "Exploring 3 files". Membaca lalu menelusuri folder tetap satu ringkasan,
 *   walau labelnya berganti di antaranya.
 *
 * Pada terminal non-TTY penggambaran ulang mustahil, jadi hanya ringkasan fase
 * yang dicetak — keluarannya tetap terbaca di log atau saat dipipe.
 */
export class StatusLine {
  private readonly interactive = Boolean(stdout.isTTY)
  /**
   * Tujuan keluaran permanen (ringkasan fase dan catatan). Disuntikkan agar
   * pemanggil dapat menahannya selama pengguna mengetik; penggambaran spinner
   * sendiri tetap langsung karena sudah dihentikan selama mengetik.
   */
  private readonly write: (text: string) => void

  constructor(write: (text: string) => void = (text) => { stdout.write(text) }) {
    this.write = write
  }

  private timer: NodeJS.Timeout | null = null
  private frame = 0
  private phase: Phase | null = null
  private summary = ''
  private phaseStartedAt = 0
  private label: string | null = null
  private detail = ''
  private labelStartedAt = 0
  private live = false
  /** Pengguna sedang mengetik; baris tidak boleh digambar ulang di atas ketikannya. */
  private typing = false

  /** Aktivitas yang tidak termasuk fase mana pun, misalnya Thinking atau Generating. */
  activity(label: string, detail = ''): void {
    this.show(label, detail)
  }

  /**
   * Pekerjaan nyata di dalam sebuah fase. Berpindah fase membekukan fase
   * sebelumnya; kembali ke fase yang sama melanjutkannya, sehingga penelaahan yang
   * terpotong oleh proses berpikir tetap satu ringkasan.
   */
  work(phase: Phase, label: string, detail: string): void {
    if (this.phase && this.phase !== phase) this.commit()
    if (!this.phase) {
      this.phase = phase
      this.phaseStartedAt = Date.now()
      this.summary = ''
    }
    this.show(label, detail)
  }

  /** Fase yang sedang berjalan, atau null bila belum ada pekerjaan. */
  get currentPhase(): Phase | null {
    return this.phase
  }

  /**
   * Membuang fase yang belum menghasilkan apa pun — misalnya tool yang ditolak
   * sebelum dijalankan — tanpa membekukannya menjadi ringkasan kosong.
   */
  discardEmpty(): void {
    if (!this.phase || this.summary) return
    this.stop()
    this.phase = null
    this.label = null
    this.detail = ''
  }

  /** Memperbarui ringkasan fase yang akan dibekukan, tanpa mengubah label hidup. */
  update(summary: string): void {
    if (this.phase) this.summary = summary
  }

  /** Membekukan fase berjalan menjadi baris ringkasan permanen. */
  commit(): void {
    if (!this.phase) {
      this.clear()
      return
    }
    const duration = formatDuration(Date.now() - this.phaseStartedAt)
    const phase = this.phase
    const summary = this.summary
    this.stop()
    this.phase = null
    this.summary = ''
    this.label = null
    this.detail = ''
    this.write(phaseLine(phase, summary, duration))
  }

  /**
   * Membekukan animasi karena pengguna mulai mengetik.
   *
   * Spinner dan ketikan berbagi baris yang sama: tanpa ini, setiap frame akan
   * menimpa huruf yang sedang diketik. Baris dikosongkan agar readline memiliki
   * barisnya sendiri, dan penggambaran berhenti sampai ketikan dikirim.
   *
   * Hanya pemanggil yang mengakhiri keadaan mengetik, lewat resume(). Ringkasan
   * fase yang dibekukan selama pengguna mengetik tidak boleh menghidupkan
   * spinner kembali di atas baris ketiknya.
   */
  pause(): boolean {
    if (this.typing) return false
    this.typing = true
    this.stop()
    return true
  }

  /** Pengguna selesai mengetik; animasi yang masih berjalan dilanjutkan. */
  resume(): void {
    if (!this.typing) return
    this.typing = false
    this.animate()
  }

  /**
   * Mencetak catatan sekali jalan tanpa mengganggu aktivitas yang sedang berjalan.
   * Baris hidup dihapus, catatan dicetak, lalu baris hidup digambar ulang.
   */
  note(text: string): void {
    this.stop()
    this.write(`${text}\n`)
    this.animate()
  }

  /** Membuang baris hidup tanpa membekukan apa pun. */
  clear(): void {
    this.stop()
    this.label = null
    this.detail = ''
  }

  private show(label: string, detail: string): void {
    // Waktu berjalan milik aktivitas; keterangan yang berubah tidak mengulangnya.
    if (label !== this.label) {
      this.label = label
      this.labelStartedAt = Date.now()
    }
    this.detail = detail
    this.animate()
  }

  private animate(): void {
    if (!this.interactive || this.typing) return
    this.draw()
    this.timer ??= setInterval(() => {
      this.frame = (this.frame + 1) % FRAMES.length
      this.draw()
    }, FRAME_MS).unref()
  }

  private draw(): void {
    if (!this.interactive || this.typing || !this.label) return
    const elapsedMs = Date.now() - this.labelStartedAt
    const elapsed = elapsedMs >= ELAPSED_AFTER_MS ? `  ${Math.floor(elapsedMs / 1_000)}s` : ''
    // Baris yang terbungkus tidak dapat digambar ulang: pembersih baris hanya
    // mengenai baris fisik terakhir, dan sisanya menumpuk di layar setiap frame.
    const columns = (stdout.columns || 80) - 1
    const fixed = 4 + LABEL_WIDTH + visibleWidth(elapsed)
    const detail = truncate(this.detail, columns - fixed)
    stdout.write(
      `${CLEAR_LINE}  ${theme.accent(FRAMES[this.frame])} ${theme.bold(this.label.padEnd(LABEL_WIDTH))}`
      + `${theme.muted(detail)}${theme.muted(elapsed)}`,
    )
    this.live = true
  }

  private stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.live) {
      stdout.write(CLEAR_LINE)
      this.live = false
    }
  }
}

/** Menghitung pekerjaan tiap fase agar ringkasannya bermakna, bukan sekadar "selesai". */
export class PhaseTally {
  private filesRead = 0
  private dirsListed = 0
  private readonly changed: string[] = []
  private commands = 0
  private failures = 0

  reset(): void {
    this.filesRead = 0
    this.dirsListed = 0
    this.changed.length = 0
    this.commands = 0
    this.failures = 0
  }

  record(tool: string, isError: boolean, target: string): void {
    if (isError) this.failures += 1
    switch (tool) {
      case 'read_file':
        this.filesRead += 1
        break
      case 'list_dir':
        this.dirsListed += 1
        break
      case 'bash':
        this.commands += 1
        break
      default:
        if (!isError && target && !this.changed.includes(target)) this.changed.push(target)
    }
  }

  /** Ringkasan fase exploring, misalnya "3 files, 5 directories". */
  exploring(): string {
    const parts: string[] = []
    if (this.filesRead) parts.push(`${this.filesRead} file${this.filesRead > 1 ? 's' : ''}`)
    if (this.dirsListed) parts.push(`${this.dirsListed} director${this.dirsListed > 1 ? 'ies' : 'y'}`)
    return parts.join(', ') || 'scanning'
  }

  /** Ringkasan fase applying, misalnya "hitung.js, app.ts · 2 commands". */
  applying(): string {
    const parts: string[] = []
    if (this.changed.length) parts.push(this.changed.join(', '))
    if (this.commands) parts.push(`${this.commands} command${this.commands > 1 ? 's' : ''}`)
    if (this.failures) parts.push(`${this.failures} failed`)
    return parts.join(' · ') || 'applying'
  }
}

/** Menentukan fase dari nama tool. */
export function phaseOf(tool: string): Phase {
  return tool === 'read_file' || tool === 'list_dir' ? 'exploring' : 'applying'
}
