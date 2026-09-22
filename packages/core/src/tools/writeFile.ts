import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Tool } from '../domain/tool.ts'
import { condense, diffLines, type DiffLine } from './diff.ts'
import { resolveInWorkspace } from './workspace.ts'
import { isProtectedWorkspacePath } from './sandbox.ts'
import { FILE_CHANGED_MESSAGE } from './fileSnapshots.ts'
import { isSensitivePath, sensitiveRefusal } from './secrets.ts'

interface Args { path: string; content: string }

export const writeFileTool: Tool<Args> = {
  name: 'write_file',
  description: 'Create a new file or overwrite an existing one inside the workspace.',
  risk: 'confirm',
  writesWorkspace: true,
  mutatesWorkspace: true,
  schema: {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create a new file or overwrite an existing one inside the workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the workspace root' },
          content: { type: 'string', description: 'Full contents to write' },
        },
        required: ['path', 'content'],
      },
    },
  },
  preview: (args) => `tulis ${args.path} (${args.content.split('\n').length} baris)`,
  async detail(args, context): Promise<DiffLine[] | null> {
    if (isProtectedWorkspacePath(args.path) || isSensitivePath(args.path)) throw new Error('path dilindungi')
    const target = resolveInWorkspace(context.workspace, args.path)
    // File baru tidak punya pembanding; seluruh isinya ditampilkan sebagai tambahan.
    let existing: string
    try {
      const buffer = await readFile(target)
      context.fileSnapshots?.capture(target, buffer)
      existing = buffer.toString('utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      context.fileSnapshots?.capture(target, null)
      const lines = diffLines('', args.content)
      // Baris baru di akhir isi bukan baris tersendiri; jangan tampilkan baris kosong ekstra.
      if (args.content.endsWith('\n') && lines.at(-1)?.text === '') lines.pop()
      return lines
    }
    if (existing === args.content) return null
    return condense(diffLines(existing, args.content))
  },
  async run(args, context) {
    if (isProtectedWorkspacePath(args.path)) return { content: `Ditolak: ${args.path} adalah path agent yang dilindungi.`, isError: true }
    const target = resolveInWorkspace(context.workspace, args.path)
    let current: Buffer | null
    try {
      current = await readFile(target)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      current = null
    }
    if (isSensitivePath(args.path)) return { content: sensitiveRefusal(args.path), isError: true }
    if (context.fileSnapshots && !context.fileSnapshots.matches(target, current)) {
      return { content: FILE_CHANGED_MESSAGE(args.path), isError: true }
    }
    await context.checkpoint?.beforeWrite(target)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, args.content, 'utf8')
    await context.checkpoint?.afterWrite(target)
    context.fileSnapshots?.observe(target, Buffer.from(args.content))
    return { content: `Tersimpan: ${args.path}` }
  },
}
