/**
 * Menampilkan ulang percakapan sesi yang dilanjutkan, seperti saat berlangsung.
 *
 * Susunannya dibangun di core (dipakai juga oleh web); di sini unsurnya digambar
 * sebagai teks terminal, dengan baris fase yang sama persis dengan tampilan langsung.
 */

import type { Message } from '@boo/core'
import { buildTranscript } from '@boo/core/presentation/transcript.ts'
import type { ViewItem } from '@boo/core/presentation/view.ts'
import { MarkdownRenderer } from './markdown.ts'
import { phaseLine } from './status.ts'
import { theme } from './theme.ts'
import { renderTodos } from './todos.ts'

/** Sesi panjang dibatasi pada tukar-jawab terakhir agar layar tidak banjir. */
export const MAX_REPLAYED_EXCHANGES = 20

function renderItem(item: ViewItem, width: number): string {
  switch (item.kind) {
    case 'user': {
      const undo = item.afterUndo ? `  ${theme.accent('↺')} ${theme.muted('perubahan berkas sebelumnya dibatalkan dengan /undo')}\n\n` : ''
      const [first, ...rest] = item.text.split('\n')
      const attachments = item.attachments?.length ? `  ${theme.muted(`gambar: ${item.attachments.join(', ')}`)}\n` : ''
      const marker = item.steering ? theme.accent('↳') : theme.accentBold('›')
      return `${undo}${marker} ${first}\n${rest.map((line) => `  ${line}\n`).join('')}${attachments}`
    }
    case 'answer': {
      const renderer = new MarkdownRenderer({ width })
      return `\n${renderer.push(item.markdown)}${renderer.end()}`
    }
    case 'phase':
      return phaseLine(item.phase, item.summary)
    case 'todos':
      return renderTodos(item.items)
    case 'decision':
      return `  ${item.allowed ? theme.accent('✓') : theme.danger('✗')} ${theme.muted(item.text)}\n`
    case 'notice':
      if (item.variant === 'error') return `\n  ${theme.danger('error')} ${item.text}\n`
      if (item.variant === 'cancelled' || item.variant === 'turn-limit') return `  ${theme.danger('✗')} ${theme.muted(item.text)}\n`
      return `  ${theme.muted(item.text)}\n`
  }
}

/**
 * Menyusun tampilan ulang percakapan. Mengembalikan teks siap tulis; baris kosong
 * memisahkan setiap tukar-jawab.
 */
export function renderTranscript(messages: Message[], width: number, maxExchanges = MAX_REPLAYED_EXCHANGES): string {
  const exchanges = buildTranscript(messages)
  const shown = exchanges.slice(-maxExchanges)
  const omitted = exchanges.length - shown.length
  const parts = shown.map((items) => items.map((item) => renderItem(item, width)).join(''))
  const note = omitted ? `  ${theme.muted(`… ${omitted} tukar-jawab sebelumnya tidak ditampilkan`)}\n\n` : ''
  return note + parts.join('\n')
}
