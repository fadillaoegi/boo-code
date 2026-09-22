/**
 * Jalur komunikasi halaman dengan server lokal.
 *
 * Token datang dari tautan yang dicetak terminal (`#token=…`). Ia dipindahkan ke
 * sessionStorage lalu dihapus dari alamat, agar tidak ikut tersalin saat alamat
 * dibagikan dan tidak tersimpan di riwayat browser.
 */

import type { ImageAttachment, ServerEvent } from '../protocol.ts'

const STORAGE_KEY = 'boo-code-token'

export class ApiError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

export function takeToken(): string | null {
  const match = /(?:^#|&)token=([0-9a-f]+)/.exec(location.hash)
  if (match) {
    try {
      sessionStorage.setItem(STORAGE_KEY, match[1])
    } catch {
      // Penyimpanan diblokir; token tetap dipakai selama halaman terbuka.
    }
    history.replaceState(null, '', location.pathname + location.search)
    return match[1]
  }
  try {
    return sessionStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

export class Api {
  private readonly token: string

  constructor(token: string) {
    this.token = token
  }

  private headers(json: boolean): HeadersInit {
    return { Authorization: `Bearer ${this.token}`, ...(json ? { 'Content-Type': 'application/json' } : {}) }
  }

  async get<T>(path: string): Promise<T> {
    const response = await fetch(path, { headers: this.headers(false) })
    return this.parse<T>(response)
  }

  async post<T = { ok: true }>(path: string, body: unknown = {}): Promise<T> {
    const response = await fetch(path, { method: 'POST', headers: this.headers(true), body: JSON.stringify(body) })
    return this.parse<T>(response)
  }

  async uploadImage(file: File): Promise<ImageAttachment> {
    const response = await fetch('/api/attachments', {
      method: 'POST',
      headers: {
        ...this.headers(false),
        'Content-Type': file.type || 'application/octet-stream',
        'X-Boo-Filename': encodeURIComponent(file.name),
      },
      body: file,
    })
    return (await this.parse<{ attachment: ImageAttachment }>(response)).attachment
  }

  private async parse<T>(response: Response): Promise<T> {
    const data = await response.json().catch(() => ({})) as { error?: string }
    if (!response.ok) throw new ApiError(data.error ?? `HTTP ${response.status}`, response.status)
    return data as T
  }

  /**
   * Berlangganan event server. Terhubung ulang otomatis bila koneksi putus;
   * setiap sambungan baru dimulai dengan snapshot, jadi tidak ada yang tertinggal.
   */
  listen(onEvent: (event: ServerEvent) => void, onConnection: (state: 'open' | 'lost' | 'unauthorized') => void): void {
    let delay = 500
    const connect = async () => {
      try {
        const response = await fetch('/api/events', { headers: this.headers(false) })
        if (response.status === 401) {
          onConnection('unauthorized')
          return
        }
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
        onConnection('open')
        delay = 500
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
        let buffer = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += value
          let boundary = buffer.indexOf('\n\n')
          while (boundary !== -1) {
            const chunk = buffer.slice(0, boundary)
            buffer = buffer.slice(boundary + 2)
            boundary = buffer.indexOf('\n\n')
            const data = chunk.split('\n').filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).join('\n')
            if (data) onEvent(JSON.parse(data) as ServerEvent)
          }
        }
      } catch {
        // Diteruskan ke penyambungan ulang di bawah.
      }
      onConnection('lost')
      setTimeout(() => void connect(), delay)
      delay = Math.min(delay * 2, 5_000)
    }
    void connect()
  }
}
