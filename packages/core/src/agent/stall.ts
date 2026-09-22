/** Guard lokal untuk tool-call identik yang tidak menghasilkan kemajuan. */

import { createHash } from 'node:crypto'

export const TOOL_LOOP_GUARD_MARK = '[BOO LOOP GUARD]'
export const TOOL_LOOP_BLOCKED_RESULT = `${TOOL_LOOP_GUARD_MARK}\nPanggilan identik diblokir karena dua percobaan sebelumnya menghasilkan hasil yang sama. Jangan ulangi lagi. Periksa bukti yang sudah ada, ubah pendekatan, atau jelaskan blocker kepada pengguna.`
export const TOOL_LOOP_STOPPED_RESULT = `${TOOL_LOOP_GUARD_MARK}\nDilewati karena agent tetap mengulang panggilan tool stagnan setelah peringatan dan pemblokiran.`
export const TOOL_LOOP_STOPPED_REPLY = 'Pekerjaan dihentikan oleh loop guard karena panggilan tool identik terus diulang tanpa kemajuan. Periksa hasil terakhir dan lanjutkan dengan pendekatan berbeda.'

/** Polling dan input proses memang sah memakai argumen yang sama berulang kali. */
const EXEMPT = new Set(['bash_output', 'bash_input'])

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? String(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export interface ToolLoopToken { key: string; name: string }
export interface ToolLoopDecision {
  action: 'allow' | 'blocked' | 'stopped'
  token: ToolLoopToken | null
  repetitions: number
}

interface Sequence {
  key: string
  name: string
  result: string | null
  identicalResults: number
  blocked: number
}

export class ToolLoopGuard {
  private sequence: Sequence | null = null

  inspect(name: string, args: Record<string, unknown>): ToolLoopDecision {
    if (EXEMPT.has(name)) {
      this.sequence = null
      return { action: 'allow', token: null, repetitions: 0 }
    }
    const key = digest(`${name}\n${canonical(args)}`)
    if (this.sequence?.key !== key) this.sequence = { key, name, result: null, identicalResults: 0, blocked: 0 }
    const token = { key, name }
    if (this.sequence.identicalResults < 2) return { action: 'allow', token, repetitions: this.sequence.identicalResults + 1 }
    if (this.sequence.blocked === 0) {
      this.sequence.blocked = 1
      return { action: 'blocked', token, repetitions: 3 }
    }
    return { action: 'stopped', token, repetitions: 4 }
  }

  /** Mengembalikan true tepat saat dua hasil identik pertama terdeteksi. */
  record(token: ToolLoopToken | null, content: string, status: 'completed' | 'failed' | 'denied'): boolean {
    if (!token || this.sequence?.key !== token.key) return false
    const result = digest(`${status}\n${content}`)
    if (status === 'denied') {
      // Satu penolakan user sudah final; pengulangan identik berikutnya diblokir.
      this.sequence.result = result
      this.sequence.identicalResults = 2
      return true
    }
    if (this.sequence.result === result) this.sequence.identicalResults += 1
    else {
      this.sequence.result = result
      this.sequence.identicalResults = 1
      this.sequence.blocked = 0
    }
    return this.sequence.identicalResults === 2
  }
}

export function toolLoopWarning(name: string): string {
  return `${TOOL_LOOP_GUARD_MARK}\n${name} mengembalikan hasil identik dua kali berturut-turut. Jangan panggil lagi dengan argumen sama. Gunakan bukti yang sudah ada, koreksi argumen, pilih tool lain, atau nyatakan blocker.`
}

export function toolLoopDeniedWarning(name: string): string {
  return `${TOOL_LOOP_GUARD_MARK}\nPengguna menolak ${name}. Keputusan itu final untuk panggilan identik ini: jangan meminta izin atau menjalankannya lagi tanpa perubahan yang bermakna.`
}

/** Instruksi trusted sementara; output tool sendiri dapat dibungkus sebagai data tak tepercaya. */
export function toolLoopSystemPrompt(name: string, stage: 'warning' | 'blocked' | 'denied'): string {
  const reason = stage === 'warning'
    ? 'detected two identical consecutive results from'
    : stage === 'denied'
      ? 'recorded the user denying'
      : 'blocked another identical invocation of'
  return `${TOOL_LOOP_GUARD_MARK}\nLocal runtime ${reason} ${JSON.stringify(name)}. Do not repeat that tool with the same arguments. Re-plan using existing evidence, change the arguments or method, ask for missing user input, or report the blocker honestly.`
}
