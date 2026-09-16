import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Tool } from '../domain/tool.ts'
import { condense, diffLines, type DiffLine } from './diff.ts'
import { resolveInWorkspace } from './workspace.ts'

interface Args { path: string; content: string }

export const writeFileTool: Tool<Args> = {
  name: 'write_file',
  description: 'Create a new file or overwrite an existing one inside the workspace.',
  risk: 'confirm',
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
    const target = resolveInWorkspace(context.workspace, args.path)
    // File baru tidak punya pembanding; seluruh isinya ditampilkan sebagai tambahan.
    let existing: string
    try {
      existing = await readFile(target, 'utf8')
    } catch {
      return args.content.split('\n').map((text) => ({ kind: 'add', text }))
    }
    if (existing === args.content) return null
    return condense(diffLines(existing, args.content))
  },
  async run(args, context) {
    const target = resolveInWorkspace(context.workspace, args.path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, args.content, 'utf8')
    return { content: `Tersimpan: ${args.path}` }
  },
}
