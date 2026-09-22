/**
 * Perintah yang berjalan di latar belakang: dev server, watcher, build panjang.
 *
 * Perintah seperti `pnpm dev` tidak pernah selesai. Dijalankan biasa, ia menahan
 * agent sampai batas waktu lalu dimatikan. Di latar belakang, agent langsung
 * mendapat id, bisa lanjut bekerja, lalu memeriksa keluarannya dengan bash_output
 * dan menghentikannya dengan bash_kill.
 *
 * Proses hidup selama Boo hidup dan dihentikan saat Boo keluar.
 */

import type { ChildProcess } from 'node:child_process'
import { cleanOutput, startCommand, terminate, TAIL_CHARACTERS, type Shell } from './shell.ts'
import type { SandboxPolicy } from './sandbox.ts'

export type BackgroundStatus = 'running' | 'exited' | 'killed'

interface BackgroundProcess {
  id: string
  command: string
  cwd: string
  child: ChildProcess
  status: BackgroundStatus
  exitCode: number | null
  startedAt: number
  /** Keluaran yang belum dibaca agent, dibatasi agar memori tidak tumbuh tanpa batas. */
  unread: string
  droppedCharacters: number
  interactive: boolean
}

export interface BackgroundSnapshot {
  id: string
  command: string
  status: BackgroundStatus
  exitCode: number | null
  output: string
  droppedCharacters: number
}

export interface BackgroundInputResult {
  ok: boolean
  error?: string
}

export class BackgroundProcesses {
  private readonly processes = new Map<string, BackgroundProcess>()
  private counter = 0
  private readonly limit: number

  constructor(limit = TAIL_CHARACTERS) {
    this.limit = limit
  }

  start(command: string, cwd: string, shell?: Shell, sandbox?: SandboxPolicy, interactive = false): string {
    this.counter += 1
    const id = `bg${this.counter}`
    const entry: BackgroundProcess = {
      id,
      command,
      cwd,
      status: 'running',
      exitCode: null,
      startedAt: Date.now(),
      unread: '',
      droppedCharacters: 0,
      interactive,
      child: startCommand(command, {
        cwd,
        ...(shell ? { shell } : {}),
        ...(sandbox ? { sandbox } : {}),
        stdin: interactive ? 'pipe' : 'ignore',
        onOutput: (chunk) => {
          entry.unread += chunk
          if (entry.unread.length > this.limit * 2) {
            entry.droppedCharacters += entry.unread.length - this.limit
            entry.unread = entry.unread.slice(-this.limit)
          }
        },
      }),
    }
    entry.child.once('close', (code) => {
      if (entry.status === 'running') entry.status = 'exited'
      entry.exitCode = code
    })
    entry.child.once('error', (error) => {
      entry.status = 'exited'
      entry.unread += `\n${error.message}`
    })
    this.processes.set(id, entry)
    return id
  }

  /** Mengirim teks ke stdin proses interaktif yang masih hidup. */
  async write(id: string, input: string, close = false): Promise<BackgroundInputResult> {
    const entry = this.processes.get(id)
    if (!entry) return { ok: false, error: `tidak ada proses latar belakang dengan id "${id}"` }
    if (entry.status !== 'running') return { ok: false, error: `proses ${id} sudah ${entry.status === 'killed' ? 'dihentikan' : 'selesai'}` }
    if (!entry.interactive) return { ok: false, error: `proses ${id} tidak dimulai dengan interactive: true` }
    const stream = entry.child.stdin
    if (!stream || stream.destroyed || stream.writableEnded) return { ok: false, error: `stdin proses ${id} sudah tertutup` }

    return new Promise((resolve) => {
      const done = (error?: Error | null) => resolve(error ? { ok: false, error: error.message } : { ok: true })
      try {
        if (close) stream.end(input, 'utf8', done)
        else stream.write(input, 'utf8', done)
      } catch (error) {
        done(error instanceof Error ? error : new Error('gagal menulis stdin'))
      }
    })
  }

  /** Keluaran baru sejak pembacaan terakhir, beserta status proses. */
  read(id: string): BackgroundSnapshot | null {
    const entry = this.processes.get(id)
    if (!entry) return null
    let output = entry.unread
    let dropped = entry.droppedCharacters
    if (output.length > this.limit) {
      dropped += output.length - this.limit
      output = output.slice(-this.limit)
    }
    entry.unread = ''
    entry.droppedCharacters = 0
    return {
      id,
      command: entry.command,
      status: entry.status,
      exitCode: entry.exitCode,
      output: cleanOutput(output),
      droppedCharacters: dropped,
    }
  }

  kill(id: string): BackgroundSnapshot | null {
    const entry = this.processes.get(id)
    if (!entry) return null
    if (entry.status === 'running') {
      entry.status = 'killed'
      terminate(entry.child)
    }
    return this.read(id)
  }

  list(): { id: string; command: string; status: BackgroundStatus }[] {
    return [...this.processes.values()].map(({ id, command, status }) => ({ id, command, status }))
  }

  killAll(): void {
    for (const entry of this.processes.values()) {
      if (entry.status !== 'running') continue
      entry.status = 'killed'
      terminate(entry.child, 0)
    }
  }
}

/** Satu pengelola untuk seluruh proses Boo, dipakai bersama oleh tool bash dan kawan-kawannya. */
export const backgroundProcesses = new BackgroundProcesses()
