/**
 * Tampilan daftar tugas yang ditulis Boo lewat todo_write.
 *
 * Dicetak utuh setiap kali diperbarui, sehingga layar menunjukkan kemajuan
 * langkah demi langkah — dan sama persis saat sesi ditampilkan ulang.
 */

import { todoProgress, type TodoItem } from '@boo/core'
import { theme } from './theme.ts'

const LABEL_WIDTH = 14

export function renderTodos(items: readonly TodoItem[]): string {
  const { done, total } = todoProgress(items)
  if (!total) return `  ${theme.accent('●')} ${theme.bold('Plan'.padEnd(LABEL_WIDTH))}${theme.muted('daftar tugas dikosongkan')}\n`
  const header = `  ${theme.accent('●')} ${theme.bold('Plan'.padEnd(LABEL_WIDTH))}${done}/${total} done\n`
  const rows = items.map((item) => {
    if (item.status === 'completed') return `    ${theme.accent('✓')} ${theme.muted(item.content)}\n`
    if (item.status === 'in_progress') return `    ${theme.accentBold('◼')} ${theme.bold(item.content)}\n`
    return `    ${theme.muted('□')} ${item.content}\n`
  })
  return header + rows.join('')
}
