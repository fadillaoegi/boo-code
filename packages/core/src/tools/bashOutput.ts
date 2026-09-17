import type { Tool } from '../domain/tool.ts'
import { backgroundProcesses, type BackgroundSnapshot } from './background.ts'

interface Args { id: string }

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
