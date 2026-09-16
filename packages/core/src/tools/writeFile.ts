import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Tool } from '../domain/tool.ts'
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
  async run(args, context) {
    const target = resolveInWorkspace(context.workspace, args.path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, args.content, 'utf8')
    return { content: `Tersimpan: ${args.path}` }
  },
}
