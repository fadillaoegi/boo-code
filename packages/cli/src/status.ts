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
 * "Orchestrating" tidak pernah dibekukan. Model berpikir di antara setiap
 * pemanggilan tool, sehingga membekukannya akan memenuhi layar dengan baris yang
 * sama berulang-ulang. Ia hanya tampil hidup, lalu digantikan fase berikutnya.
 */

import { stdout } from 'node:process'
import { theme } from './theme.ts'

/** Tiga fase yang mencerminkan apa yang benar-benar dikerjakan agent. */
export type Phase = 'orchestrating' | 'exploring' | 'applying'

export const PHASE_LABEL: Record<Phase, string> = {
  orchestrating: 'Orchestrating',
  exploring: 'Exploring',
  applying: 'Applying',
}

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const FRAME_MS = 80
const CLEAR_LINE = '\r\u001b[2K'
const LABEL_WIDTH = 12

function formatDuration(ms: number): string {
  return ms < 1_000 ? `${ms}ms` : `${(ms / 1_000).toFixed(1)}s`
}

/**
 * Menggambar satu baris status yang diperbarui di tempat.
 *
 * Pada terminal non-TTY penggambaran ulang mustahil, jadi setiap fase dicetak
 * sekali saja saat selesai — keluarannya tetap terbaca di log atau saat dipipe.
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
  /** Fase kerja yang akan dibekukan; orchestrating tidak pernah mengisinya. */
  private phase: Phase | null = null
  private detail = ''
  private startedAt = 0
  /** Apa yang sedang digambar — bisa berbeda dari fase kerja saat model berpikir. */
  private showing: Phase | null = null
  private live = false
  /** Pengguna sedang mengetik; baris tidak boleh digambar ulang di atas ketikannya. */
  private typing = false

  /** Model sedang berpikir. Tidak mengganti maupun membekukan fase kerja. */
  thinking(): void {
    this.showing = 'orchestrating'
    this.animate()
  }

  /**
   * Menandai pekerjaan nyata. Berpindah antara exploring dan applying membekukan
   * fase sebelumnya; kembali ke fase yang sama melanjutkannya, sehingga
   * penelaahan yang terpotong oleh proses berpikir tetap satu baris.
   */
  work(phase: Phase, detail: string): void {
    if (this.phase && this.phase !== phase) this.commit()
    if (!this.phase) {
      this.phase = phase
      this.startedAt = Date.now()
    }
    this.detail = detail
    this.showing = phase
    this.animate()
  }

  /** Memperbarui keterangan fase kerja yang sedang berjalan. */
  update(detail: string): void {
    if (!this.phase) return
    this.detail = detail
    if (this.showing !== 'orchestrating') this.draw()
  }

  /** Membekukan fase kerja berjalan menjadi baris ringkasan permanen. */
  commit(): void {
    if (!this.phase) {
      this.clear()
      return
    }
    const duration = formatDuration(Date.now() - this.startedAt)
    const label = PHASE_LABEL[this.phase].padEnd(LABEL_WIDTH)
    const detail = this.detail
    this.stop()
    this.phase = null
    this.showing = null
    this.detail = ''
    this.write(`  ${theme.accent('●')} ${theme.bold(label)}${detail}  ${theme.muted(duration)}\n`)
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

  /** Pengguna selesai mengetik; animasi fase yang masih berjalan dilanjutkan. */
  resume(): void {
    if (!this.typing) return
    this.typing = false
    this.animate()
  }

  /**
   * Mencetak catatan sekali jalan tanpa mengganggu fase yang sedang berjalan.
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
    this.showing = null
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
    if (!this.interactive || this.typing || !this.showing) return
    const label = PHASE_LABEL[this.showing].padEnd(LABEL_WIDTH)
    const detail = this.showing === 'orchestrating' ? '' : this.detail
    stdout.write(`${CLEAR_LINE}  ${theme.accent(FRAMES[this.frame])} ${theme.bold(label)}${theme.muted(detail)}`)
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
