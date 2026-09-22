/**
 * WhatsApp Web untuk akun pribadi melalui Chrome/Edge yang dibuka pengguna.
 *
 * Tidak ada cookie, password, QR, maupun isi chat yang disimpan oleh Boo. Tool
 * hanya terhubung ke Chrome DevTools Protocol (CDP) di loopback dan memakai
 * sesi WhatsApp Web yang pengguna login sendiri. Semua pengiriman pesan selalu
 * meminta izin baru; tidak ada mode "always allow".
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Tool } from '../domain/tool.ts'

const DEFAULT_CDP_URL = 'http://127.0.0.1:9222'
const WHATSAPP_URL = 'https://web.whatsapp.com/'
const CONNECT_TIMEOUT_MS = 8_000
const UI_TIMEOUT_MS = 20_000
const POLL_MS = 250

export const WHATSAPP_CONFIG_PATH = join(homedir(), '.boo', 'whatsapp.json')

export class WhatsAppError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WhatsAppError'
  }
}

interface CdpTarget {
  type?: string
  url?: string
  webSocketDebuggerUrl?: string
}

interface CdpReply {
  id?: number
  result?: Record<string, unknown>
  error?: { message?: string }
}

function localEndpoint(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new WhatsAppError('Alamat CDP WhatsApp tidak valid.')
  }
  const localHosts = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])
  if (!['http:', 'https:'].includes(url.protocol) || !localHosts.has(url.hostname.toLowerCase())) {
    throw new WhatsAppError('CDP WhatsApp harus berada di localhost/127.0.0.1, bukan host jaringan.')
  }
  return url
}

/** Membaca alamat CDP lokal tanpa menyimpan sesi/credential browser. */
export function whatsappCdpUrl(home = homedir(), environment: NodeJS.ProcessEnv = process.env): string {
  const fromEnvironment = environment.BOO_WHATSAPP_CDP_URL?.trim()
  if (fromEnvironment) return localEndpoint(fromEnvironment).toString()
  let parsed: { cdpUrl?: unknown }
  try {
    parsed = JSON.parse(readFileSync(join(home, '.boo', 'whatsapp.json'), 'utf8')) as { cdpUrl?: unknown }
  } catch {
    // Konfigurasi opsional; default CDP lokal dipakai.
    return DEFAULT_CDP_URL
  }
  if (typeof parsed.cdpUrl === 'string' && parsed.cdpUrl.trim()) return localEndpoint(parsed.cdpUrl).toString()
  return DEFAULT_CDP_URL
}

function endpointPath(endpoint: string, path: string): URL {
  return new URL(path, endpoint.endsWith('/') ? endpoint : `${endpoint}/`)
}

async function cdpTargets(endpoint: string): Promise<CdpTarget[]> {
  let response: Response
  try {
    response = await fetch(endpointPath(endpoint, 'json/list'), { signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS) })
  } catch {
    throw new WhatsAppError('Chrome/Edge tidak dapat dihubungi di CDP lokal. Jalankan browser dengan --remote-debugging-port=9222 terlebih dahulu.')
  }
  if (!response.ok) throw new WhatsAppError(`CDP browser merespons HTTP ${response.status}.`)
  const body = await response.json() as unknown
  return Array.isArray(body) ? body as CdpTarget[] : []
}

class CdpSession {
  private nextId = 0
  private readonly pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>()
  private readonly socket: WebSocket

  private constructor(socket: WebSocket) {
    this.socket = socket
    socket.addEventListener('message', (event) => {
      let reply: CdpReply
      try { reply = JSON.parse(String(event.data)) as CdpReply } catch { return }
      if (typeof reply.id !== 'number') return
      const pending = this.pending.get(reply.id)
      if (!pending) return
      this.pending.delete(reply.id)
      if (reply.error?.message) pending.reject(new WhatsAppError(`CDP: ${reply.error.message}`))
      else pending.resolve(reply.result ?? {})
    })
    socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) pending.reject(new WhatsAppError('Koneksi ke browser terputus.'))
      this.pending.clear()
    })
  }

  static async open(url: string): Promise<CdpSession> {
    const socket = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close()
        reject(new WhatsAppError('Koneksi CDP ke tab WhatsApp habis waktu.'))
      }, CONNECT_TIMEOUT_MS)
      socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new WhatsAppError('Koneksi CDP ke tab WhatsApp gagal.')) }, { once: true })
    })
    return new CdpSession(socket)
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new WhatsAppError('Koneksi browser sudah ditutup.'))
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate<T>(expression: string): Promise<T> {
    const reply = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    const details = reply.exceptionDetails as { text?: string } | undefined
    if (details) throw new WhatsAppError(`Halaman WhatsApp gagal diproses: ${details.text ?? 'error JavaScript'}`)
    return ((reply.result as { value?: T } | undefined)?.value) as T
  }

  async insertText(text: string): Promise<void> {
    await this.send('Input.insertText', { text })
  }

  /** Menutup socket CDP saja; Chrome/Edge pengguna tetap berjalan. */
  disconnect(): void {
    this.socket.close()
  }
}

async function sessionForWhatsApp(): Promise<CdpSession> {
  const endpoint = whatsappCdpUrl()
  const target = (await cdpTargets(endpoint)).find((item) => item.type === 'page' && item.url?.startsWith('https://web.whatsapp.com/') && item.webSocketDebuggerUrl)
  if (!target?.webSocketDebuggerUrl) {
    throw new WhatsAppError(`Tidak menemukan tab ${WHATSAPP_URL}. Buka WhatsApp Web pada browser CDP, lalu login dengan akun Anda.`)
  }
  return CdpSession.open(target.webSocketDebuggerUrl)
}

const SEARCH_SELECTORS = [
  '[data-testid="chat-list-search"] [contenteditable="true"]',
  '[data-testid="chat-list-search"]',
  '[contenteditable="true"][data-tab="3"]',
]
const COMPOSER_SELECTORS = [
  '[data-testid="conversation-compose-box-input"] [contenteditable="true"]',
  '[data-testid="conversation-compose-box-input"]',
  'footer [contenteditable="true"][role="textbox"]',
]
const ACTIVE_CHAT_SELECTORS = [
  '[data-testid="conversation-info-header-chat-title"]',
  'header [title]',
]
const SEND_SELECTORS = ['[data-testid="send"]', 'button[aria-label="Send"]', 'span[data-icon="send"]']

function visibleSelectorExpression(selectors: string[]): string {
  return `(() => { for (const selector of ${JSON.stringify(selectors)}) { const element = document.querySelector(selector); if (element && element.getClientRects().length) return selector } return null })()`
}

async function waitForSelector(session: CdpSession, selectors: string[], description: string): Promise<string> {
  const until = Date.now() + UI_TIMEOUT_MS
  while (Date.now() < until) {
    const selector = await session.evaluate<string | null>(visibleSelectorExpression(selectors))
    if (selector) return selector
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
  throw new WhatsAppError(`${description} tidak ditemukan. Pastikan WhatsApp Web sudah selesai dimuat dan login.`)
}

async function focusAndClear(session: CdpSession, selector: string): Promise<void> {
  const found = await session.evaluate<boolean>(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element) return false; element.focus(); if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) element.value = ''; else element.textContent = ''; element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' })); return true })()`)
  if (!found) throw new WhatsAppError('Kolom WhatsApp berubah sebelum dapat digunakan.')
}

async function waitForUniqueRecipient(session: CdpSession, recipient: string): Promise<void> {
  const expected = recipient.trim().toLocaleLowerCase()
  const expression = `(() => {
    const visible = (element) => element.getClientRects().length > 0;
    const cells = [...document.querySelectorAll('[data-testid="cell-frame-container"], [role="listitem"]')].filter(visible);
    const matches = cells.filter((cell) => cell.innerText.trim().toLocaleLowerCase().split('\\n').includes(${JSON.stringify(expected)}));
    if (matches.length !== 1) return matches.length;
    matches[0].click();
    return 1;
  })()`
  const until = Date.now() + UI_TIMEOUT_MS
  while (Date.now() < until) {
    const matches = await session.evaluate<number>(expression)
    if (matches === 1) return
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
  throw new WhatsAppError(`Kontak "${recipient}" tidak ditemukan secara unik. Gunakan nama kontak persis seperti yang tampil di WhatsApp.`)
}

/**
 * Kotak tulis selalu ada untuk chat lama, jadi jangan menganggapnya bukti bahwa
 * klik hasil pencarian sudah berpindah chat. Nama header harus cocok sebelum
 * isi pesan dapat diketik.
 */
async function waitForActiveRecipient(session: CdpSession, recipient: string): Promise<void> {
  const expected = recipient.trim().toLocaleLowerCase()
  const until = Date.now() + UI_TIMEOUT_MS
  while (Date.now() < until) {
    const active = await session.evaluate<string | null>(`(() => { for (const selector of ${JSON.stringify(ACTIVE_CHAT_SELECTORS)}) { const element = document.querySelector(selector); if (element && element.getClientRects().length) return (element.getAttribute('title') || element.textContent || '').trim() } return null })()`)
    if (active?.toLocaleLowerCase() === expected) return
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
  throw new WhatsAppError(`WhatsApp tidak dapat memastikan chat aktif adalah "${recipient}". Pesan dibatalkan demi keamanan.`)
}

function validateMessage(recipient: unknown, message: unknown): { recipient: string; message: string } {
  const to = typeof recipient === 'string' ? recipient.trim() : ''
  const text = typeof message === 'string' ? message.trim() : ''
  if (!to || to.length > 120 || to.includes('\0')) throw new WhatsAppError('Penerima WhatsApp harus berupa nama kontak yang valid (maksimum 120 karakter).')
  if (!text || text.length > 4_000 || text.includes('\0')) throw new WhatsAppError('Isi pesan WhatsApp harus 1–4000 karakter.')
  return { recipient: to, message: text }
}

/** Status tidak membaca riwayat chat; hanya memeriksa tab dan kesiapan UI. */
export async function whatsappStatus(): Promise<string> {
  let session: CdpSession | null = null
  try {
    session = await sessionForWhatsApp()
    await waitForSelector(session, SEARCH_SELECTORS, 'Kolom pencarian WhatsApp')
    return 'WhatsApp Web siap. Akun sudah login dan tab dapat dipakai untuk menyiapkan pengiriman pesan.'
  } finally {
    session?.disconnect()
  }
}

/** Mengirim satu pesan setelah persetujuan eksplisit dari pengguna. */
export async function sendWhatsAppMessage(recipient: string, message: string): Promise<string> {
  const input = validateMessage(recipient, message)
  let session: CdpSession | null = null
  try {
    session = await sessionForWhatsApp()
    const search = await waitForSelector(session, SEARCH_SELECTORS, 'Kolom pencarian WhatsApp')
    await focusAndClear(session, search)
    await session.insertText(input.recipient)
    await waitForUniqueRecipient(session, input.recipient)
    await waitForActiveRecipient(session, input.recipient)
    const composer = await waitForSelector(session, COMPOSER_SELECTORS, 'Kolom penulisan pesan')
    await focusAndClear(session, composer)
    await session.insertText(input.message)
    const send = await waitForSelector(session, SEND_SELECTORS, 'Tombol kirim')
    const clicked = await session.evaluate<boolean>(`(() => { const element = document.querySelector(${JSON.stringify(send)}); if (!element) return false; element.click(); return true })()`)
    if (!clicked) throw new WhatsAppError('Tombol kirim berubah sebelum pesan dapat dikirim.')
    return `Pesan WhatsApp dikirim ke ${input.recipient}.`
  } finally {
    session?.disconnect()
  }
}

const STATUS_DESCRIPTION = 'Check whether a user-owned Chrome or Edge session is connected locally and has WhatsApp Web open and logged in. This never reads chat messages, contacts, cookies, QR codes, or credentials.'
const SEND_DESCRIPTION = 'Send one WhatsApp Web message from the user-owned logged-in browser session. The recipient name and full message are shown to the user for approval every time. Use the exact contact name as displayed in WhatsApp. Never send without approval.'

export const whatsappStatusTool: Tool = {
  name: 'whatsapp_status',
  description: STATUS_DESCRIPTION,
  risk: 'safe',
  schema: { type: 'function', function: { name: 'whatsapp_status', description: STATUS_DESCRIPTION, parameters: { type: 'object', properties: {} } } },
  preview: () => 'cek status WhatsApp Web',
  async run() {
    try {
      return { content: await whatsappStatus() }
    } catch (error) {
      return { content: `WhatsApp Web belum siap: ${error instanceof Error ? error.message : 'kesalahan tidak dikenal'}`, isError: true }
    }
  },
}

interface SendArgs { recipient: string; message: string }

export const whatsappSendMessageTool: Tool<SendArgs> = {
  name: 'whatsapp_send_message',
  description: SEND_DESCRIPTION,
  risk: 'confirm',
  allowAlways: false,
  schema: {
    type: 'function',
    function: {
      name: 'whatsapp_send_message',
      description: SEND_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          recipient: { type: 'string', description: 'Exact WhatsApp contact name, as displayed in WhatsApp Web' },
          message: { type: 'string', description: 'Message body to send' },
        },
        required: ['recipient', 'message'],
      },
    },
  },
  preview: (args) => `kirim WhatsApp ke ${args.recipient}`,
  async run(args) {
    try {
      return { content: await sendWhatsAppMessage(args.recipient, args.message) }
    } catch (error) {
      return { content: `Pesan WhatsApp tidak dikirim: ${error instanceof Error ? error.message : 'kesalahan tidak dikenal'}`, isError: true }
    }
  },
}
