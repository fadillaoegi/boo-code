import { readFile } from 'node:fs/promises'
import type { Tool } from '../domain/tool.ts'
import { resolveInWorkspace } from './workspace.ts'

const MAX_CHARACTERS = 60_000

interface Args { path: string }

export const readFileTool: Tool<Args> = {
  name: 'read_file',
  description: 'Read the contents of a text file inside the workspace.',
  risk: 'safe',
  schema: {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a text file inside the workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the workspace root' },
        },
        required: ['path'],
      },
    },
  },
  preview: (args) => `baca ${args.path}`,
  async run(args, context) {
    const target = resolveInWorkspace(context.workspace, args.path)
    const raw = await readFile(target, 'utf8')
    // Nomor baris membantu model merujuk lokasi saat mengedit.
    const numbered = raw
      .split('\n')
      .map((line, index) => `${String(index + 1).padStart(5)}\t${line}`)
      .join('\n')
    if (numbered.length <= MAX_CHARACTERS) return { content: numbered }
    return {
      content: `${numbered.slice(0, MAX_CHARACTERS)}\n\n[… file dipotong, ${raw.length} karakter total …]`,
    }
  },
}
