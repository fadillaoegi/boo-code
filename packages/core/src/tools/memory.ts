/** Tool memori proyek: baca otomatis, perubahan selalu melalui approval. */

import type { Tool } from '../domain/tool.ts'
import {
  addProjectMemory,
  loadProjectMemories,
  memoryTextError,
  removeProjectMemory,
  type MemoryCategory,
} from '../agent/memory.ts'

interface AddArgs { text: string; category?: MemoryCategory }
interface RemoveArgs { id: string }

const categories = ['architecture', 'command', 'constraint', 'convention', 'preference', 'other'] as const

export const memoryListTool: Tool = {
  name: 'memory_list',
  description: 'List persistent notes for this workspace. Memories are also included automatically in the model context.',
  risk: 'safe',
  schema: {
    type: 'function',
    function: { name: 'memory_list', description: 'List approved persistent project memories and their IDs.', parameters: { type: 'object', properties: {} } },
  },
  preview: () => 'lihat memori proyek',
  async run(_args, context) {
    const entries = loadProjectMemories(context.workspace, context.home)
    if (!entries.length) return { content: 'Memori proyek kosong.' }
    return { content: entries.map((entry) => `[${entry.id}] ${entry.category}: ${entry.text}`).join('\n') }
  },
}

export const memoryAddTool: Tool<AddArgs> = {
  name: 'memory_add',
  description: 'Save one stable, reusable project fact across sessions. Requires fresh user approval. Never store secrets, transient status, task summaries, or assumptions.',
  risk: 'confirm',
  allowAlways: false,
  schema: {
    type: 'function',
    function: {
      name: 'memory_add',
      description: 'Remember a stable project fact only when it will materially help future sessions. The exact note is shown for approval.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Self-contained factual note, maximum 1000 characters; never include credentials' },
          category: { type: 'string', enum: [...categories], description: 'Type of project knowledge' },
        },
        required: ['text'],
      },
    },
  },
  preview: (args) => `ingat: ${typeof args.text === 'string' ? args.text : ''}`,
  async run(args, context) {
    const error = memoryTextError(args.text)
    if (error) return { content: `Gagal: ${error}`, isError: true }
    if (!context.home) return { content: 'Gagal: direktori home tidak tersedia untuk menyimpan memori.', isError: true }
    try {
      const result = await addProjectMemory(context.workspace, context.home, args.text, args.category ?? 'other')
      return { content: result.added ? `Tersimpan sebagai memori [${result.entry.id}].` : `Catatan yang sama sudah ada sebagai [${result.entry.id}].` }
    } catch (error) {
      return { content: `Gagal: ${error instanceof Error ? error.message : 'memori tidak dapat disimpan'}`, isError: true }
    }
  },
}

export const memoryRemoveTool: Tool<RemoveArgs> = {
  name: 'memory_remove',
  description: 'Remove one persistent project memory by ID. Requires fresh user approval.',
  risk: 'confirm',
  allowAlways: false,
  schema: {
    type: 'function',
    function: {
      name: 'memory_remove',
      description: 'Forget one project memory after listing memories and identifying its exact ID.',
      parameters: { type: 'object', properties: { id: { type: 'string', pattern: '^[a-f0-9]{8}$' } }, required: ['id'] },
    },
  },
  preview: (args) => `hapus memori ${args.id}`,
  async detail(args, context) {
    const entry = loadProjectMemories(context.workspace, context.home).find((item) => item.id === args.id)
    return entry ? [{ kind: 'remove', text: `[${entry.id}] ${entry.category}: ${entry.text}`, oldNumber: 1 }] : null
  },
  async run(args, context) {
    if (!context.home) return { content: 'Gagal: direktori home tidak tersedia untuk mengubah memori.', isError: true }
    try {
      const removed = await removeProjectMemory(context.workspace, context.home, args.id)
      return removed ? { content: `Memori [${removed.id}] dihapus: ${removed.text}` } : { content: `Gagal: memori [${args.id}] tidak ditemukan.`, isError: true }
    } catch (error) {
      return { content: `Gagal: ${error instanceof Error ? error.message : 'memori tidak dapat dihapus'}`, isError: true }
    }
  },
}
