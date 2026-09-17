/**
 * Daftar tugas yang ditulis model untuk pekerjaan bertahap.
 *
 * Tugas yang panjang mudah tersesat: model lupa langkah yang tersisa, atau
 * berhenti setelah separuh jalan. Dengan daftar yang diperbarui di setiap langkah,
 * rencananya terlihat oleh pengguna dan tetap ada di riwayat bagi model sendiri.
 *
 * Tool ini tidak menyimpan apa pun: daftar terbaru selalu dapat dibaca ulang dari
 * pemanggilan terakhirnya di riwayat, termasuk setelah sesi dilanjutkan.
 */

import type { Message } from '../domain/message.ts'
import type { Tool } from '../domain/tool.ts'

export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export interface TodoItem {
  content: string
  status: TodoStatus
}

interface Args { todos: unknown }

const STATUSES = new Set<TodoStatus>(['pending', 'in_progress', 'completed'])

/** Memvalidasi argumen; mengembalikan pesan kesalahan bila tidak sah. */
export function parseTodos(raw: unknown): TodoItem[] | string {
  if (!Array.isArray(raw)) return 'todos harus berupa array.'
  const items: TodoItem[] = []
  for (const [index, entry] of raw.entries()) {
    const { content, status } = (entry ?? {}) as { content?: unknown; status?: unknown }
    if (typeof content !== 'string' || !content.trim()) return `todos[${index}].content harus berisi teks.`
    if (typeof status !== 'string' || !STATUSES.has(status as TodoStatus)) {
      return `todos[${index}].status harus pending, in_progress, atau completed.`
    }
    items.push({ content: content.trim(), status: status as TodoStatus })
  }
  const active = items.filter((item) => item.status === 'in_progress').length
  if (active > 1) return `Hanya satu tugas yang boleh in_progress; saat ini ${active}. Selesaikan satu dulu.`
  return items
}

export function todoProgress(items: readonly TodoItem[]): { done: number; total: number; current: string | undefined } {
  return {
    done: items.filter((item) => item.status === 'completed').length,
    total: items.length,
    current: items.find((item) => item.status === 'in_progress')?.content,
  }
}

/** Daftar tugas terbaru di riwayat, dari pemanggilan todo_write terakhir yang berhasil. */
export function latestTodos(messages: readonly Message[]): TodoItem[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    for (const call of [...(messages[index].tool_calls ?? [])].reverse()) {
      if (call.function.name !== 'todo_write') continue
      try {
        const parsed = parseTodos((JSON.parse(call.function.arguments || '{}') as Args).todos)
        if (typeof parsed !== 'string') return parsed
      } catch {
        // Argumen rusak; cari pemanggilan sebelumnya.
      }
    }
  }
  return []
}

const DESCRIPTION = `Create or update the task list for the current request. Send the complete list every time.
Use it for work with three or more distinct steps, or when the user gives several tasks. Skip it for simple one-step requests.
- Write the list before starting; mark a task in_progress right before working on it, and completed as soon as it is done.
- Keep exactly one task in_progress while working.
- Add tasks you discover along the way; remove ones that turn out to be unnecessary.`

export const todoWriteTool: Tool<Args> = {
  name: 'todo_write',
  description: DESCRIPTION,
  risk: 'safe',
  schema: {
    type: 'function',
    function: {
      name: 'todo_write',
      description: DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            description: 'The complete, updated task list',
            items: {
              type: 'object',
              properties: {
                content: { type: 'string', description: 'What needs to be done, as a short imperative sentence' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
              },
              required: ['content', 'status'],
            },
          },
        },
        required: ['todos'],
      },
    },
  },
  preview: (args) => `perbarui daftar tugas (${Array.isArray(args.todos) ? args.todos.length : 0})`,
  async run(args) {
    const parsed = parseTodos(args.todos)
    if (typeof parsed === 'string') return { content: `Gagal: ${parsed}`, isError: true }
    const { done, total, current } = todoProgress(parsed)
    if (total && done === total) return { content: `Daftar tugas diperbarui: semua ${total} tugas selesai.` }
    return {
      content: `Daftar tugas diperbarui: ${done}/${total} selesai.${current ? ` Sedang dikerjakan: ${current}.` : ''} Lanjutkan tugasnya.`,
    }
  },
}
