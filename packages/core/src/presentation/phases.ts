/**
 * Fase pekerjaan agent dan ringkasannya, dipakai bersama CLI dan web.
 *
 * Yang ingin diketahui pengguna bukan setiap isi berkas yang dibaca, melainkan
 * Boo sedang apa dan sudah sejauh mana: "Exploring 3 files", "Applying app.ts".
 */

/** Tiga fase yang mencerminkan apa yang benar-benar dikerjakan agent. */
/** Kelompok pekerjaan yang dibekukan menjadi baris ringkasan. */
export type Phase = 'exploring' | 'applying'

export const PHASE_LABEL: Record<Phase, string> = {
  exploring: 'Exploring',
  applying: 'Applying',
}

/** Menghitung pekerjaan tiap fase agar ringkasannya bermakna, bukan sekadar "selesai". */
export class PhaseTally {
  private filesRead = 0
  private dirsListed = 0
  private searches = 0
  private readonly changed: string[] = []
  private commands = 0
  private checks = 0
  private stopped = 0
  private failures = 0

  reset(): void {
    this.filesRead = 0
    this.dirsListed = 0
    this.searches = 0
    this.changed.length = 0
    this.commands = 0
    this.checks = 0
    this.stopped = 0
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
      case 'glob':
      case 'grep':
        this.searches += 1
        break
      case 'bash':
        this.commands += 1
        break
      case 'bash_output':
        this.checks += 1
        break
      case 'bash_kill':
        this.stopped += 1
        break
      case 'todo_write':
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
    if (this.searches) parts.push(`${this.searches} search${this.searches > 1 ? 'es' : ''}`)
    return parts.join(', ') || 'scanning'
  }

  /** Ringkasan fase applying, misalnya "hitung.js, app.ts · 2 commands". */
  applying(): string {
    const parts: string[] = []
    if (this.changed.length) parts.push(this.changed.join(', '))
    if (this.commands) parts.push(`${this.commands} command${this.commands > 1 ? 's' : ''}`)
    if (this.checks) parts.push(`${this.checks} output check${this.checks > 1 ? 's' : ''}`)
    if (this.stopped) parts.push(`${this.stopped} stopped`)
    if (this.failures) parts.push(`${this.failures} failed`)
    return parts.join(' · ') || 'applying'
  }
}

/** Menentukan fase dari nama tool. */
const EXPLORING_TOOLS = new Set(['read_file', 'list_dir', 'glob', 'grep'])

export function phaseOf(tool: string): Phase {
  return EXPLORING_TOOLS.has(tool) ? 'exploring' : 'applying'
}
