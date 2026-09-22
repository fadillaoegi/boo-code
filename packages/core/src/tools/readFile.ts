import { readFile } from 'node:fs/promises'
import type { Tool } from '../domain/tool.ts'
import { isSensitivePath, sensitiveRefusal } from './secrets.ts'
import { resolveInWorkspace } from './workspace.ts'

/** Batas isi yang dikirim per pembacaan; berkas yang lebih besar dibaca per bagian. */
export const MAX_CHARACTERS = 60_000
export const DEFAULT_LINE_LIMIT = 2_000
/** Baris hasil minify bisa ratusan ribu karakter; satu baris seperti itu menghabiskan konteks. */
export const MAX_LINE_CHARACTERS = 2_000

interface Args { path: string; offset?: number; limit?: number }

const DESCRIPTION = `Read a text file inside the workspace. Lines are numbered.
Reads up to ${DEFAULT_LINE_LIMIT} lines by default. For large files the result says which lines were returned; read the rest with offset and limit, or grep for what you need first.`

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.floor(value) : undefined
}

export const readFileTool: Tool<Args> = {
  name: 'read_file',
  description: DESCRIPTION,
  risk: 'safe',
  parallelSafe: true,
  schema: {
    type: 'function',
    function: {
      name: 'read_file',
      description: DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the workspace root' },
          offset: { type: 'number', description: 'Line number to start reading from (1-based)' },
          limit: { type: 'number', description: `Maximum number of lines to read (default ${DEFAULT_LINE_LIMIT})` },
        },
        required: ['path'],
      },
    },
  },
  preview: (args) => `baca ${args.path}`,
  async run(args, context) {
    if (isSensitivePath(args.path)) {
      return { content: sensitiveRefusal(args.path), isError: true }
    }
    const target = resolveInWorkspace(context.workspace, args.path)
    const buffer = await readFile(target)
    context.fileSnapshots?.observe(target, buffer)
    if (!buffer.length) return { content: '(berkas kosong)' }
    if (buffer.subarray(0, 8_000).includes(0)) {
      return { content: `Gagal: ${args.path} adalah berkas biner (${buffer.length} byte), bukan teks.`, isError: true }
    }
    const lines = buffer.toString('utf8').split('\n')
    if (lines.length > 1 && lines.at(-1) === '') lines.pop()
    const total = lines.length

    const start = positiveInteger(args.offset) ?? 1
    if (start > Math.max(total, 1)) {
      return { content: `Gagal: ${args.path} hanya ${total} baris; offset ${start} melewati akhir berkas.`, isError: true }
    }
    const limit = positiveInteger(args.limit) ?? DEFAULT_LINE_LIMIT

    // Nomor baris membantu model merujuk lokasi saat mengedit.
    const output: string[] = []
    let used = 0
    let end = start - 1
    let shortened = 0
    for (let index = start - 1; index < Math.min(total, start - 1 + limit); index += 1) {
      let line = lines[index]
      if (line.length > MAX_LINE_CHARACTERS) {
        line = `${line.slice(0, MAX_LINE_CHARACTERS)} [… baris dipotong, ${line.length} karakter …]`
        shortened += 1
      }
      const numbered = `${String(index + 1).padStart(5)}\t${line}`
      // Setidaknya satu baris selalu dikirim, agar pembacaan per bagian tetap maju.
      if (output.length && used + numbered.length + 1 > MAX_CHARACTERS) break
      output.push(numbered)
      used += numbered.length + 1
      end = index + 1
    }

    const notes: string[] = []
    if (end < total) {
      notes.push(`[Baris ${start}–${end} dari ${total}. Lanjutkan dengan offset ${end + 1}, atau cari bagian yang dibutuhkan dengan grep.]`)
    } else if (start > 1) {
      notes.push(`[Baris ${start}–${end} dari ${total}; akhir berkas.]`)
    }
    if (shortened) notes.push(`[${shortened} baris yang sangat panjang dipotong.]`)
    const body = output.join('\n')
    return { content: notes.length ? `${body}\n\n${notes.join('\n')}` : body }
  },
}
