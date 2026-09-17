import { readFile, writeFile } from 'node:fs/promises'
import type { Tool } from '../domain/tool.ts'
import { condense, diffLines, type DiffLine } from './diff.ts'
import { isSensitivePath, sensitiveRefusal } from './secrets.ts'
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
  async detail(args, context): Promise<DiffLine[] | null> {
    if (args.old_text === args.new_text) return null
    // Diff atas seluruh berkas, bukan hanya cuplikannya, supaya pratinjau memuat
    // nomor baris sesungguhnya dan baris di sekitarnya — cuplikan sendirian tidak
    // memberi tahu di mana perubahan itu jatuh.
    try {
      if (isSensitivePath(args.path)) throw new Error('rahasia')
      const original = await readFile(resolveInWorkspace(context.workspace, args.path), 'utf8')
      if (original.split(args.old_text).length - 1 === 1) {
        return condense(diffLines(original, original.replace(args.old_text, args.new_text)))
      }
    } catch {
      // Berkas tak terbaca atau cuplikan tidak unik: tool akan menolak saat dijalankan,
      // tetapi pratinjau cuplikan tetap berguna untuk keputusan izin.
    }
    return condense(diffLines(args.old_text, args.new_text))
  },
  async run(args, context) {
    if (isSensitivePath(args.path)) {
      return { content: sensitiveRefusal(args.path), isError: true }
    }
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
