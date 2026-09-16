import { readFile, writeFile } from 'node:fs/promises'
import type { Tool } from '../domain/tool.ts'
import { resolveInWorkspace } from './workspace.ts'

interface Args { path: string; old_text: string; new_text: string }

export const editFileTool: Tool<Args> = {
  name: 'edit_file',
  description: 'Replace an exact snippet of text in a file. The snippet must appear exactly once.',
  risk: 'confirm',
  schema: {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Replace an exact snippet of text in a file. The snippet must appear exactly once.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the workspace root' },
          old_text: { type: 'string', description: 'Exact text to replace, including indentation' },
          new_text: { type: 'string', description: 'Replacement text' },
        },
        required: ['path', 'old_text', 'new_text'],
      },
    },
  },
  preview: (args) => `ubah ${args.path}`,
  async run(args, context) {
    const target = resolveInWorkspace(context.workspace, args.path)
    const original = await readFile(target, 'utf8')

    const occurrences = original.split(args.old_text).length - 1
    // Kegagalan dikembalikan sebagai hasil, bukan exception: model perlu
    // membacanya supaya bisa memperbaiki sendiri pada putaran berikutnya.
    if (occurrences === 0) {
      return { content: `Gagal: teks tidak ditemukan di ${args.path}.`, isError: true }
    }
    if (occurrences > 1) {
      return {
        content: `Gagal: teks muncul ${occurrences} kali di ${args.path}. Sertakan konteks agar unik.`,
        isError: true,
      }
    }

    await writeFile(target, original.replace(args.old_text, args.new_text), 'utf8')
    return { content: `Diubah: ${args.path}` }
  },
}
