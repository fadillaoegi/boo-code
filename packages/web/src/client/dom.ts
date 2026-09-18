/**
 * Pembuat elemen DOM dan penggambar markdown.
 *
 * Semua teks masuk lewat textContent; tidak ada innerHTML di halaman ini.
 */

import { highlightLine } from '@boo/core/presentation/highlight.ts'
import { parseMarkdown, type Block, type Inline } from './markdown.ts'

type Child = Node | string | null | undefined | false
type Attributes = Record<string, string | boolean | undefined | ((event: Event) => void)>

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attributes: Attributes = {}, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag)
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined || value === false) continue
    if (typeof value === 'function') element.addEventListener(name.replace(/^on/, '').toLowerCase(), value)
    else if (name === 'class') element.className = String(value)
    else element.setAttribute(name, value === true ? '' : value)
  }
  append(element, children)
  return element
}

export function append(parent: Node, children: (Child | Child[])[]): void {
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue
    parent.appendChild(typeof child === 'string' ? document.createTextNode(child) : child)
  }
}

export function clear(element: Element): void {
  while (element.firstChild) element.removeChild(element.firstChild)
}

/** Baris kode dengan sorotan sintaks; warna dari design token yang sama dengan CLI. */
export function codeLine(text: string, language: string): HTMLSpanElement {
  const line = h('span', { class: 'code-line' })
  for (const run of highlightLine(text, language)) {
    const span = h('span', {}, run.text)
    if (run.style.color) span.style.color = run.style.color
    if (run.style.italic) span.style.fontStyle = 'italic'
    line.appendChild(span)
  }
  return line
}

function copyButton(text: () => string): HTMLButtonElement {
  const button = h('button', { class: 'copy', type: 'button', title: 'Salin' }, 'Salin')
  button.addEventListener('click', () => {
    void navigator.clipboard?.writeText(text()).then(() => {
      button.textContent = 'Tersalin'
      setTimeout(() => { button.textContent = 'Salin' }, 1_200)
    })
  })
  return button
}

function renderInlines(inlines: Inline[]): Child[] {
  return inlines.map((inline): Child => {
    switch (inline.type) {
      case 'text': return inline.text
      case 'code': return h('code', { class: 'inline-code' }, inline.text)
      case 'strong': return h('strong', {}, renderInlines(inline.children))
      case 'em': return h('em', {}, renderInlines(inline.children))
      case 'del': return h('del', {}, renderInlines(inline.children))
      case 'break': return h('br')
      case 'link': return h('a', { href: inline.href, target: '_blank', rel: 'noopener noreferrer' }, renderInlines(inline.children))
    }
  })
}

function renderBlock(block: Block): Child {
  switch (block.type) {
    case 'paragraph': return h('p', {}, renderInlines(block.inlines))
    case 'heading': {
      const level = Math.min(6, block.level + 1) as 2 | 3 | 4 | 5 | 6
      return h(`h${level}`, {}, renderInlines(block.inlines))
    }
    case 'rule': return h('hr')
    case 'quote': return h('blockquote', {}, block.blocks.map(renderBlock))
    case 'code': {
      const lines = block.text.split('\n')
      return h('div', { class: 'code-block' },
        h('div', { class: 'code-head' }, h('span', {}, block.language || 'kode'), copyButton(() => block.text)),
        h('pre', {}, h('code', {}, lines.flatMap((line, index) => [index ? '\n' : '', codeLine(line, block.language)]))),
      )
    }
    case 'list': {
      const items = block.items.map((item) => h('li', { class: item.checked === null ? undefined : 'task' },
        item.checked === null ? null : h('span', { class: `check${item.checked ? ' done' : ''}`, 'aria-hidden': 'true' }, item.checked ? '✓' : ''),
        item.blocks.map(renderBlock),
      ))
      return block.ordered
        ? h('ol', { start: block.start === 1 ? undefined : String(block.start) }, items)
        : h('ul', {}, items)
    }
    case 'table':
      return h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, block.header.map((cell, column) => h('th', { class: block.align[column] ? `align-${block.align[column]}` : undefined }, renderInlines(cell))))),
        h('tbody', {}, block.rows.map((row) => h('tr', {}, row.map((cell, column) => h('td', { class: block.align[column] ? `align-${block.align[column]}` : undefined }, renderInlines(cell)))))),
      ))
  }
}

export function renderMarkdown(target: Element, markdown: string): void {
  clear(target)
  append(target, parseMarkdown(markdown).map(renderBlock))
}
