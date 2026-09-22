import type { Tool } from '../domain/tool.ts'
import { backgroundProcesses, type BackgroundSnapshot } from './background.ts'

interface Args { id: string }

interface InputArgs {
  id: string
  input: string
  append_newline?: boolean
  close_stdin?: boolean
}

export const MAX_BACKGROUND_INPUT_CHARACTERS = 4_096

/** Laporan status dan keluaran baru untuk model. */
export function describeSnapshot(snapshot: BackgroundSnapshot): string {
  const status = snapshot.status === 'running'
    ? 'masih berjalan'
    : snapshot.status === 'killed'
      ? 'dihentikan'
      : `selesai (exit ${snapshot.exitCode ?? '?'})`
  const dropped = snapshot.droppedCharacters ? `\n[… ${snapshot.droppedCharacters} karakter keluaran lama dilewati …]` : ''
  const output = snapshot.output ? `\n${snapshot.output}` : '\n(tidak ada keluaran baru)'
  return `${snapshot.id} · ${snapshot.command} · ${status}${dropped}${output}`
}

function unknownId(id: string): string {
  const known = backgroundProcesses.list().map((entry) => `${entry.id} (${entry.command})`)
  return `Gagal: tidak ada proses latar belakang dengan id "${id}".${known.length ? ` Yang ada: ${known.join(', ')}.` : ''}`
}

export const bashOutputTool: Tool<Args> = {
  name: 'bash_output',
  description: 'Read new output and the status of a command started with run_in_background.',
  risk: 'safe',
  schema: {
    type: 'function',
    function: {
      name: 'bash_output',
      description: 'Read new output (since the last read) and the status of a command started with run_in_background.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'The id returned by bash, for example bg1' } },
        required: ['id'],
      },
    },
  },
  preview: (args) => args.id,
  async run(args) {
    const snapshot = backgroundProcesses.read(args.id)
    return snapshot ? { content: describeSnapshot(snapshot) } : { content: unknownId(args.id), isError: true }
  },
}

export const bashKillTool: Tool<Args> = {
  name: 'bash_kill',
  description: 'Stop a command started with run_in_background.',
  // Hanya dapat menghentikan proses yang dimulai Boo sendiri, dengan izin saat dimulai.
  risk: 'safe',
  schema: {
    type: 'function',
    function: {
      name: 'bash_kill',
      description: 'Stop a command started with run_in_background, including its child processes.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'The id returned by bash, for example bg1' } },
        required: ['id'],
      },
    },
  },
  preview: (args) => args.id,
  async run(args) {
    const snapshot = backgroundProcesses.kill(args.id)
    return snapshot ? { content: describeSnapshot(snapshot) } : { content: unknownId(args.id), isError: true }
  },
}

export const bashInputTool: Tool<InputArgs> = {
  name: 'bash_input',
  description: 'Send text to a background command that was started with interactive: true. Every input requires fresh user approval.',
  risk: 'confirm',
  allowAlways: false,
  runsCommand: true,
  schema: {
    type: 'function',
    function: {
      name: 'bash_input',
      description: 'Send text to stdin of a running background command started with interactive: true. This is a pipe, not a full TTY. Use bash_output afterward to read the response.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The id returned by bash, for example bg1' },
          input: { type: 'string', description: `Exact text to send, at most ${MAX_BACKGROUND_INPUT_CHARACTERS} characters` },
          append_newline: { type: 'boolean', description: 'Append one newline after input (default true)' },
          close_stdin: { type: 'boolean', description: 'Close stdin after this write, for commands that wait for EOF' },
        },
        required: ['id', 'input'],
      },
    },
  },
  preview: (args) => `${args.id} · ${JSON.stringify(args.input)}`,
  async run(args) {
    if (!/^bg\d+$/.test(args.id)) return { content: `Gagal: id proses tidak sah: "${args.id}".`, isError: true }
    if (typeof args.input !== 'string') return { content: 'Gagal: input harus berupa teks.', isError: true }
    if (args.input.length > MAX_BACKGROUND_INPUT_CHARACTERS) {
      return { content: `Gagal: input melebihi batas ${MAX_BACKGROUND_INPUT_CHARACTERS} karakter.`, isError: true }
    }
    const unsupportedControl = [...args.input].some((character) => {
      const code = character.charCodeAt(0)
      return code === 0x7f || (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d)
    })
    if (unsupportedControl) {
      return { content: 'Gagal: input memuat karakter kontrol yang tidak didukung. Gunakan bash_kill untuk menghentikan proses.', isError: true }
    }
    const appendNewline = args.append_newline !== false
    const payload = `${args.input}${appendNewline ? '\n' : ''}`
    if (!payload && !args.close_stdin) return { content: 'Gagal: input kosong tidak mengirim apa pun.', isError: true }
    const result = await backgroundProcesses.write(args.id, payload, args.close_stdin === true)
    if (!result.ok) return { content: `Gagal mengirim input ke ${args.id}: ${result.error ?? 'kesalahan tidak dikenal'}.`, isError: true }
    const closed = args.close_stdin ? ' dan stdin ditutup' : ''
    return { content: `${payload.length} karakter dikirim ke ${args.id}${closed}. Gunakan bash_output untuk membaca respons baru.` }
  },
}
