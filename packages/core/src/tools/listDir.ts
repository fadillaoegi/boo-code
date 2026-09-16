import { readdir } from 'node:fs/promises'
import type { Tool } from '../domain/tool.ts'
import { isSensitivePath } from './secrets.ts'
import { resolveInWorkspace } from './workspace.ts'

const IGNORED = new Set(['node_modules', '.git', 'dist', '.DS_Store'])

interface Args { path?: string }

export const listDirTool: Tool<Args> = {
  name: 'list_dir',
  description: 'List files and folders in a directory inside the workspace.',
  risk: 'safe',
  schema: {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List files and folders in a directory inside the workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path relative to the workspace root; defaults to the root' },
        },
      },
    },
  },
  preview: (args) => `lihat isi ${args.path || '.'}`,
  async run(args, context) {
    const target = resolveInWorkspace(context.workspace, args.path || '.')
    const entries = await readdir(target, { withFileTypes: true })
    const visible = entries
      .filter((entry) => !IGNORED.has(entry.name))
      // File rahasia tetap terdaftar — model perlu tahu ia ada — tetapi
      // ditandai agar tidak membuang giliran mencoba membacanya.
      .map((entry) => entry.isDirectory()
        ? `${entry.name}/`
        : isSensitivePath(entry.name) ? `${entry.name}  [rahasia, tidak dapat dibaca]` : entry.name)
      .sort()
    return { content: visible.length ? visible.join('\n') : '(kosong)' }
  },
}
