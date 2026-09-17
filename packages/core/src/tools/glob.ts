import type { Tool } from '../domain/tool.ts'
import { findFiles } from './search.ts'
import { isSensitivePath } from './secrets.ts'
import { resolveInWorkspace } from './workspace.ts'

const MAX_RESULTS = 200

interface Args { pattern: string; path?: string }

export const globTool: Tool<Args> = {
  name: 'glob',
  description: 'Find files by name pattern.',
  risk: 'safe',
  schema: {
    type: 'function',
    function: {
      name: 'glob',
      description: 'Find files whose paths match a glob pattern, such as "src/**/*.ts" or "**/*config*". '
        + 'Results are sorted by most recently modified. Use this to locate files instead of listing directories one by one.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern relative to the search directory' },
          path: { type: 'string', description: 'Directory to search in, relative to the workspace root; defaults to the root' },
        },
        required: ['pattern'],
      },
    },
  },
  preview: (args) => `cari berkas ${args.pattern}`,
  async run(args, context) {
    const directory = resolveInWorkspace(context.workspace, args.path || '.')
    const files = await findFiles(context.workspace, directory, args.pattern)
    if (!files.length) return { content: `Tidak ada berkas yang cocok dengan pola ${args.pattern}.` }

    // Berkas yang baru diubah paling mungkin berkaitan dengan pekerjaan saat ini.
    files.sort((a, b) => b.modifiedAt - a.modifiedAt)
    const shown = files.slice(0, MAX_RESULTS).map((file) => isSensitivePath(file.path)
      ? `${file.path}  [rahasia, tidak dapat dibaca]`
      : file.path)
    const rest = files.length - shown.length
    return { content: rest ? `${shown.join('\n')}\n(${shown.length} dari ${files.length} berkas; persempit polanya)` : shown.join('\n') }
  },
}
