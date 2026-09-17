import { readFile, stat } from 'node:fs/promises'
import type { Tool } from '../domain/tool.ts'
import { findFiles } from './search.ts'
import { isSensitivePath } from './secrets.ts'
import { resolveInWorkspace } from './workspace.ts'

const MAX_MATCHES = 200
const MAX_LINE_LENGTH = 240
/** Berkas lebih besar dari ini hampir pasti hasil generate atau data, bukan kode. */
const MAX_FILE_BYTES = 1_000_000
const BINARY_PROBE_BYTES = 8_000
const NUL = String.fromCharCode(0)

interface Args {
  pattern: string
  path?: string
  include?: string
  ignore_case?: boolean
  files_only?: boolean
}

function looksBinary(content: string): boolean {
  return content.slice(0, BINARY_PROBE_BYTES).includes(NUL)
}

export const grepTool: Tool<Args> = {
  name: 'grep',
  description: 'Search file contents with a regular expression.',
  risk: 'safe',
  schema: {
    type: 'function',
    function: {
      name: 'grep',
      description: 'Search file contents for a regular expression and return matching lines as "path:line: text". '
        + 'Use this to find where something is defined or used before reading whole files.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'JavaScript regular expression to search for' },
          path: { type: 'string', description: 'File or directory to search, relative to the workspace root; defaults to the root' },
          include: { type: 'string', description: 'Only search files matching this glob, such as "**/*.ts"' },
          ignore_case: { type: 'boolean', description: 'Match case-insensitively' },
          files_only: { type: 'boolean', description: 'Return only the paths of matching files with match counts' },
        },
        required: ['pattern'],
      },
    },
  },
  preview: (args) => `cari "${args.pattern}"${args.path ? ` di ${args.path}` : ''}`,
  async run(args, context) {
    let expression: RegExp
    try {
      expression = new RegExp(args.pattern, args.ignore_case ? 'i' : '')
    } catch (error) {
      // Dikembalikan sebagai hasil agar model dapat membetulkan polanya sendiri.
      return { content: `Gagal: pola regex tidak valid: ${error instanceof Error ? error.message : args.pattern}`, isError: true }
    }

    const target = resolveInWorkspace(context.workspace, args.path || '.')
    const targetInfo = await stat(target)
    const files = targetInfo.isFile()
      ? [{ path: args.path as string, absolute: target, modifiedAt: targetInfo.mtimeMs }]
      : await findFiles(context.workspace, target, args.include || '**/*')

    const lines: string[] = []
    const counts: string[] = []
    let matches = 0
    let skippedSecrets = 0
    let truncated = false

    for (const file of files.sort((a, b) => a.path.localeCompare(b.path))) {
      if (context.signal?.aborted) return { content: 'Dibatalkan: pencarian dihentikan oleh pengguna.', isError: true }
      // Isi berkas rahasia tidak boleh sampai ke model, termasuk lewat pencarian.
      if (isSensitivePath(file.path)) {
        skippedSecrets += 1
        continue
      }
      let content: string
      try {
        if ((await stat(file.absolute)).size > MAX_FILE_BYTES) continue
        content = await readFile(file.absolute, 'utf8')
      } catch {
        continue
      }
      if (looksBinary(content)) continue

      let inFile = 0
      const fileLines = content.split('\n')
      for (let index = 0; index < fileLines.length; index += 1) {
        if (!expression.test(fileLines[index])) continue
        inFile += 1
        if (args.files_only) continue
        if (matches >= MAX_MATCHES) {
          truncated = true
          break
        }
        const text = fileLines[index].length > MAX_LINE_LENGTH
          ? `${fileLines[index].slice(0, MAX_LINE_LENGTH)}…`
          : fileLines[index]
        lines.push(`${file.path}:${index + 1}: ${text}`)
        matches += 1
      }
      if (inFile && args.files_only) counts.push(`${file.path} (${inFile})`)
      if (truncated) break
    }

    const notes: string[] = []
    if (truncated) notes.push(`hasil dibatasi ${MAX_MATCHES} baris; persempit pola atau path`)
    if (skippedSecrets) notes.push(`${skippedSecrets} berkas rahasia dilewati`)
    const body = args.files_only ? counts : lines
    if (!body.length) {
      return { content: `Tidak ada yang cocok dengan ${args.pattern}.${notes.length ? ` (${notes.join('; ')})` : ''}` }
    }
    return { content: `${body.join('\n')}${notes.length ? `\n(${notes.join('; ')})` : ''}` }
  },
}
