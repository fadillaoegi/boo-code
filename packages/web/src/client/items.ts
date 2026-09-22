/**
 * Penggambar unsur percakapan dan kartu pertanyaan.
 *
 * Tampilannya mengikuti CLI: pertanyaan pengguna, jawaban markdown, baris fase
 * Exploring/Applying, daftar tugas, keputusan izin, dan pemberitahuan.
 */

import type { ViewItem } from '@boo/core/presentation/view.ts'
import type { DiffRow, QuestionBody, QuestionOption, QuestionView, StatusView } from '../protocol.ts'
import { codeLine, h, renderMarkdown } from './dom.ts'

const PHASE_LABEL = { exploring: 'Exploring', applying: 'Applying' } as const

export function formatDuration(ms: number): string {
  return ms < 1_000 ? `${ms}ms` : `${(ms / 1_000).toFixed(1)}s`
}

/** Elemen untuk satu unsur. Jawaban menyimpan markdown mentahnya untuk pembaruan. */
export function renderItem(item: ViewItem): HTMLElement {
  switch (item.kind) {
    case 'user':
      return h('div', { class: 'item user', 'data-id': item.id },
        item.afterUndo ? h('div', { class: 'undo-note' }, '↺ perubahan berkas sebelumnya dibatalkan dengan /undo') : null,
        h('div', { class: `bubble${item.spec ? ' spec' : ''}${item.steering ? ' steering' : ''}` },
          item.steering ? h('span', { class: 'tag' }, 'Arahan') : null,
          item.spec ? h('span', { class: 'tag' }, 'Spec') : null,
          item.spec ?? item.text,
          item.attachments?.length ? h('div', { class: 'message-attachments' }, item.attachments.map((name) => h('span', {}, `▧ ${name}`))) : null,
        ),
      )

    case 'answer': {
      const body = h('div', { class: 'markdown' })
      renderMarkdown(body, item.markdown)
      return h('div', { class: 'item answer', 'data-id': item.id },
        h('img', { class: 'avatar', src: '/logo.png', alt: '' }),
        body,
      )
    }

    case 'phase':
      return h('div', { class: `item phase${item.live ? ' live' : ''}`, 'data-id': item.id },
        h('span', { class: 'dot' }),
        h('span', { class: 'label' }, PHASE_LABEL[item.phase]),
        h('span', { class: 'summary' }, item.summary),
        item.durationMs !== undefined ? h('span', { class: 'duration' }, formatDuration(item.durationMs)) : null,
      )

    case 'todos': {
      const done = item.items.filter((todo) => todo.status === 'completed').length
      return h('div', { class: 'item todos', 'data-id': item.id },
        h('div', { class: 'todos-head' }, h('span', { class: 'dot' }), h('span', { class: 'label' }, 'Plan'), h('span', { class: 'summary' }, `${done}/${item.items.length} done`)),
        h('ul', {}, item.items.map((todo) => h('li', { class: todo.status },
          h('span', { class: 'mark' }, todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '◼' : '□'),
          h('span', {}, todo.content),
        ))),
      )
    }

    case 'decision':
      return h('div', { class: `item decision ${item.allowed ? 'allowed' : 'denied'}`, 'data-id': item.id },
        h('span', { class: 'mark' }, item.allowed ? '✓' : '✗'),
        h('span', {}, item.text),
      )

    case 'notice': {
      const icon = { cancelled: '✗', error: '!', 'turn-limit': '■', info: 'i', retry: '↻', compacted: '↻', undo: '↺', success: '✓' }[item.variant]
      return h('div', { class: `item notice ${item.variant}`, 'data-id': item.id },
        h('span', { class: 'mark' }, icon),
        h('span', { class: 'text' }, item.text),
      )
    }
  }
}

export function renderStatus(status: StatusView): HTMLElement {
  const elapsed = Math.floor((Date.now() - status.startedAt) / 1_000)
  return h('div', { class: 'status' },
    h('span', { class: 'spinner', 'aria-hidden': 'true' }),
    h('span', { class: 'label' }, status.label),
    h('span', { class: 'detail' }, status.detail),
    elapsed >= 1 ? h('span', { class: 'elapsed' }, `${elapsed}s`) : null,
    h('span', { class: 'hint' }, 'Esc untuk berhenti'),
  )
}

function diffRow(row: DiffRow, language: string): HTMLElement {
  if (row.kind === 'skip') {
    return h('div', { class: 'diff-row skip' }, h('span', { class: 'num' }), h('span', { class: 'num' }), h('span', { class: 'sign' }), h('span', { class: 'text' }, `⋮ ${row.skipped} baris tidak berubah`))
  }
  const sign = row.kind === 'add' ? '+' : row.kind === 'remove' ? '-' : ' '
  return h('div', { class: `diff-row ${row.kind}` },
    h('span', { class: 'num' }, row.oldNumber === undefined ? '' : String(row.oldNumber)),
    h('span', { class: 'num' }, row.newNumber === undefined ? '' : String(row.newNumber)),
    h('span', { class: 'sign' }, sign),
    h('span', { class: 'text' }, codeLine(row.text, language)),
  )
}

function renderBody(body: QuestionBody): HTMLElement {
  switch (body.type) {
    case 'diff':
      return h('div', { class: 'q-body diff' },
        h('div', { class: 'diff-head' }, h('span', { class: 'path' }, body.path), h('span', { class: 'added' }, `+${body.added}`), h('span', { class: 'removed' }, `-${body.removed}`)),
        h('div', { class: 'diff-rows' }, body.rows.map((row) => diffRow(row, body.language))),
        body.truncated ? h('div', { class: 'diff-more' }, `… ${body.truncated} baris lagi tidak ditampilkan`) : null,
      )
    case 'command':
      return h('div', { class: 'q-body command' },
        body.description ? h('div', { class: 'description' }, body.description) : null,
        h('pre', {}, h('code', {}, h('span', { class: 'prompt' }, '$ '), body.command.split('\n').flatMap((line, index) => [index ? '\n' : '', codeLine(line, 'sh')]))),
      )
    case 'undo':
      return h('div', { class: 'q-body undo' },
        h('ul', {}, body.entries.map((entry) => h('li', { class: entry.action },
          h('span', { class: 'action' }, entry.action === 'restore' ? '↺ kembalikan' : '✗ hapus'),
          h('span', { class: 'path' }, entry.label),
          h('span', { class: 'added' }, `+${entry.added}`),
          h('span', { class: 'removed' }, `-${entry.removed}`),
          entry.modifiedSince ? h('div', { class: 'warning' }, '! diubah lagi setelah Boo mengubahnya; perubahan itu ikut hilang') : null,
        ))),
        body.ranCommands ? h('p', { class: 'muted' }, 'Perubahan oleh perintah bash di permintaan ini tidak ikut dibatalkan.') : null,
      )
    case 'text':
      return h('div', { class: 'q-body text' }, body.text)
  }
}

/**
 * Kartu pertanyaan: izin, batas langkah, langkah spec, atau /undo.
 * Angka 1–9 memilih langsung; pilihan yang meminta teks membuka isian dulu.
 */
export function renderQuestion(question: QuestionView, onAnswer: (option: QuestionOption, text: string) => void): { element: HTMLElement; choose(index: number): void; editing(): boolean } {
  const input = h('textarea', { class: 'q-input', rows: '2', hidden: true })
  let pending: QuestionOption | null = null
  const submitInput = h('button', { class: 'button primary small', type: 'button', hidden: true }, 'Kirim')

  const choose = (option: QuestionOption) => {
    if (option.input && pending !== option) {
      pending = option
      input.hidden = false
      submitInput.hidden = false
      submitInput.textContent = option.label
      input.placeholder = option.input.placeholder
      input.focus()
      return
    }
    if (option.input?.required && !input.value.trim()) {
      input.focus()
      return
    }
    onAnswer(option, option.input ? input.value : '')
  }

  submitInput.addEventListener('click', () => pending && choose(pending))
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      if (pending) choose(pending)
    }
    if (event.key === 'Escape') {
      event.stopPropagation()
      pending = null
      input.hidden = true
      submitInput.hidden = true
    }
  })

  const buttons = question.options.map((option, index) => h('button', {
    class: `button${option.tone ? ` ${option.tone}` : ''}`,
    type: 'button',
    'data-shortcut': String(index + 1),
    onClick: () => choose(option),
  }, h('kbd', {}, String(index + 1)), option.label))

  const card = h('section', { class: 'question', 'data-id': question.id },
    h('header', {}, h('span', { class: 'title' }, question.title), question.subject ? h('span', { class: 'subject' }, question.subject) : null),
    question.body ? renderBody(question.body) : null,
    h('p', { class: 'prompt' }, question.prompt),
    h('div', { class: 'options' }, buttons),
    h('div', { class: 'q-form' }, input, submitInput),
  )
  return {
    element: card,
    choose: (index) => {
      const option = question.options[index]
      if (option) choose(option)
    },
    editing: () => !input.hidden,
  }
}
