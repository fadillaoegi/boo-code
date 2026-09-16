import { readdir } from 'node:fs/promises'
import type { Tool } from '../domain/tool.ts'
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
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      .sort()
    return { content: visible.length ? visible.join('\n') : '(kosong)' }
  },
}
