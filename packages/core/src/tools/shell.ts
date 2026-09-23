/**
 * Menjalankan perintah shell untuk tool bash.
 *
 * Tiga hal yang membuat pendekatan sederhana — execFile ke /bin/zsh — rapuh:
 *
 * - **Shell.** zsh tidak ada di kebanyakan server Linux. Shell pengguna dipakai bila
 *   sintaksnya kompatibel POSIX, selain itu bash, lalu sh.
 * - **Keluaran.** execFile membunuh proses yang keluarannya melewati maxBuffer,
 *   sehingga `pnpm install` yang cerewet dilaporkan gagal padahal tidak. Di sini
 *   keluaran selalu diterima; yang disimpan hanya awal dan akhirnya, karena di
 *   situlah perintah yang dijalankan dan pesan error berada.
 * - **Proses anak.** `pnpm test` menjalankan node, yang menjalankan proses lain.
 *   Membunuh shell saja meninggalkan cucunya tetap hidup. Perintah dijalankan
 *   dalam process group sendiri dan seluruh grupnya yang dihentikan.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import { commandEnvironment } from './commandEnvironment.ts'
import { sandboxLaunch, type SandboxPolicy, type SandboxStatus } from './sandbox.ts'

export { commandEnvironment } from './commandEnvironment.ts'

/** Shell yang sintaks `-c`-nya kompatibel; fish dan nushell tidak termasuk. */
const POSIX_SHELLS = new Set(['bash', 'zsh', 'sh', 'dash', 'ksh'])
const FALLBACK_SHELLS = ['/bin/bash', '/usr/bin/bash', '/bin/sh']

export interface Shell {
  file: string
  name: string
  args(command: string): string[]
}

export function resolveShell(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): Shell {
  if (platform === 'win32') {
    const file = env.ComSpec || 'cmd.exe'
    return { file, name: 'cmd', args: (command) => ['/d', '/s', '/c', `"${command}"`] }
  }
  const preferred = env.SHELL
  const candidates = [
    ...(preferred && POSIX_SHELLS.has(basename(preferred)) ? [preferred] : []),
    ...FALLBACK_SHELLS,
  ]
  const file = candidates.find((candidate) => exists(candidate)) ?? '/bin/sh'
  return { file, name: basename(file), args: (command) => ['-c', command] }
}

/** Awal dan akhir keluaran; bagian tengah yang panjang diganti catatan. */
export const HEAD_CHARACTERS = 8_000
export const TAIL_CHARACTERS = 22_000

/**
 * Menampung keluaran tanpa batas masuk, dengan memori terbatas. Bagian awal
 * disimpan utuh, bagian akhir disimpan bergulir.
 */
export class OutputBuffer {
  private head = ''
  private tail = ''
  private total = 0
  private readonly headLimit: number
  private readonly tailLimit: number

  constructor(headLimit = HEAD_CHARACTERS, tailLimit = TAIL_CHARACTERS) {
    this.headLimit = headLimit
    this.tailLimit = tailLimit
  }

  append(chunk: string): void {
    this.total += chunk.length
    const room = this.headLimit - this.head.length
    if (room > 0) {
      this.head += chunk.slice(0, room)
      chunk = chunk.slice(room)
    }
    if (!chunk) return
    this.tail += chunk
    // Dipangkas sesekali, bukan setiap potongan, agar tidak menyalin string terus.
    if (this.tail.length > this.tailLimit * 2) this.tail = this.tail.slice(-this.tailLimit)
  }

  toString(): string {
    const tail = this.tail.slice(-this.tailLimit)
    const omitted = this.total - this.head.length - tail.length
    const text = omitted > 0
      ? `${this.head}\n\n[… ${omitted} karakter keluaran di tengah dilewati …]\n\n${tail}`
      : this.head + tail
    return cleanOutput(text)
  }
}

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, 'g')

/**
 * Warna terminal dan bilah progres tidak berguna bagi model dan memakan konteks.
 * Baris yang ditulis ulang dengan carriage return hanya disimpan versi terakhirnya.
 */
export function cleanOutput(text: string): string {
  return text
    .replace(ANSI_PATTERN, '')
    .replace(/\r+\n/g, '\n')
    .split('\n')
    .map((line) => line.slice(line.lastIndexOf('\r') + 1))
    .join('\n')
    .trim()
}

/** Proses yang masih hidup, dihentikan bila Boo keluar agar tidak ada yang yatim. */
const live = new Set<ChildProcess>()
let exitHookInstalled = false

function installExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.once('exit', () => {
    for (const child of live) killTree(child, 'SIGKILL')
  })
}

/** Menghentikan proses beserta seluruh process group-nya. */
export function killTree(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return
  try {
    if (process.platform === 'win32') child.kill(signal)
    else process.kill(-child.pid, signal)
  } catch {
    // Sudah berhenti di antara pemeriksaan dan pengiriman sinyal.
  }
}

/** Menghentikan dengan sopan, lalu paksa bila tidak berhenti dalam waktu singkat. */
export function terminate(child: ChildProcess, graceMs = 2_000): void {
  killTree(child, 'SIGTERM')
  const timer = setTimeout(() => killTree(child, 'SIGKILL'), graceMs)
  timer.unref()
  child.once('exit', () => clearTimeout(timer))
}

export interface StartOptions {
  cwd: string
  onOutput?: (chunk: string) => void
  shell?: Shell
  sandbox?: SandboxPolicy
  /** LSP dan protocol server membutuhkan stdin dua arah; command biasa tetap ditutup. */
  stdin?: 'ignore' | 'pipe'
}

const sandboxByChild = new WeakMap<ChildProcess, SandboxStatus>()

/** Memulai perintah. Masukan standar ditutup, jadi perintah yang bertanya tidak menggantung. */
export function startCommand(command: string, { cwd, onOutput, shell = resolveShell(), sandbox = { mode: 'workspace-write' }, stdin = 'ignore' }: StartOptions): ChildProcess {
  const env = { ...commandEnvironment(), TERM: 'dumb', NO_COLOR: '1', FORCE_COLOR: '0' }
  const launch = sandboxLaunch(shell, command, cwd, sandbox, process.platform, existsSync, env)
  const child = spawn(launch.file, launch.args, {
    cwd,
    stdio: [stdin, 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsVerbatimArguments: process.platform === 'win32' && launch.status.backend === 'none',
    env,
  })
  sandboxByChild.set(child, launch.status)
  installExitHook()
  live.add(child)
  child.once('exit', () => live.delete(child))
  child.once('error', () => live.delete(child))
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  if (onOutput) {
    child.stdout?.on('data', onOutput)
    child.stderr?.on('data', onOutput)
  }
  return child
}

export interface CommandResult {
  output: string
  exitCode: number | null
  timedOut: boolean
  timeoutReason?: 'idle' | 'maximum'
  durationMs: number
  cancelled: boolean
  /** Shell gagal dijalankan sama sekali. */
  spawnError?: string
  sandbox: SandboxStatus
}

export interface RunOptions extends StartOptions {
  /** Batas tanpa keluaran baru. Tanpa maxRuntimeMs, ini tetap hard timeout lama. */
  timeoutMs: number
  /** Hard cap opsional untuk command adaptif yang terus menunjukkan progres. */
  maxRuntimeMs?: number
  signal?: AbortSignal
}

/** Menjalankan perintah sampai selesai, habis waktu, atau dihentikan pengguna. */
export function runCommand(command: string, options: RunOptions): Promise<CommandResult> {
  const buffer = new OutputBuffer()
  const { signal, timeoutMs, maxRuntimeMs, onOutput } = options
  const startedAt = Date.now()

  return new Promise((resolve) => {
    if (signal?.aborted) {
      const sandbox = sandboxLaunch(options.shell ?? resolveShell(), command, options.cwd, options.sandbox ?? { mode: 'workspace-write' }).status
      resolve({ output: '', exitCode: null, timedOut: false, durationMs: 0, cancelled: true, sandbox })
      return
    }
    let idleTimer: NodeJS.Timeout | undefined
    let maximumTimer: NodeJS.Timeout | undefined
    let timeoutReason: CommandResult['timeoutReason']
    const expire = (reason: NonNullable<CommandResult['timeoutReason']>) => {
      if (timeoutReason) return
      timeoutReason = reason
      terminate(child)
    }
    const resetIdleTimer = () => {
      if (!maxRuntimeMs) return
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => expire('idle'), timeoutMs)
    }
    const child = startCommand(command, {
      ...options,
      onOutput: (chunk) => {
        buffer.append(chunk)
        onOutput?.(chunk)
        resetIdleTimer()
      },
    })
    const sandbox = sandboxByChild.get(child) ?? sandboxLaunch(options.shell ?? resolveShell(), command, options.cwd, options.sandbox ?? { mode: 'workspace-write' }).status

    let cancelled = false
    if (maxRuntimeMs) {
      resetIdleTimer()
      maximumTimer = setTimeout(() => expire('maximum'), Math.max(timeoutMs, maxRuntimeMs))
    } else {
      maximumTimer = setTimeout(() => expire('maximum'), timeoutMs)
    }
    const onAbort = () => {
      cancelled = true
      terminate(child)
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    let finished = false
    const finish = (result: Pick<CommandResult, 'exitCode' | 'spawnError'>) => {
      if (finished) return
      finished = true
      if (idleTimer) clearTimeout(idleTimer)
      if (maximumTimer) clearTimeout(maximumTimer)
      signal?.removeEventListener('abort', onAbort)
      resolve({
        output: buffer.toString(),
        timedOut: Boolean(timeoutReason),
        ...(timeoutReason ? { timeoutReason } : {}),
        durationMs: Math.max(0, Date.now() - startedAt),
        cancelled,
        sandbox,
        ...result,
      })
    }
    child.once('error', (error) => finish({ exitCode: null, spawnError: error.message }))
    // 'close', bukan 'exit': keluaran yang masih di pipa harus terbaca seluruhnya.
    child.once('close', (code) => finish({ exitCode: code }))
  })
}
