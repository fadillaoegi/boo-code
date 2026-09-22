/**
 * Server HTTP lokal untuk Boo Code web.
 *
 * Halaman ini dapat menyetujui perintah shell di komputer pengguna, jadi pintunya
 * dijaga berlapis:
 *
 * - **Hanya 127.0.0.1.** Server tidak pernah mendengarkan antarmuka jaringan lain.
 * - **Token acak per jalan.** Setiap panggilan API wajib membawa token yang hanya
 *   tercetak di terminal. Situs lain yang terbuka di browser yang sama tidak
 *   mengetahuinya, sehingga tidak dapat mengirim permintaan atas nama pengguna.
 * - **Header Host diperiksa.** Mencegah DNS rebinding: domain penyerang yang
 *   diarahkan ke 127.0.0.1 tetap ditolak karena Host-nya bukan alamat lokal.
 * - **Origin diperiksa** pada permintaan yang mengubah sesuatu, dan badan JSON
 *   diwajibkan, sehingga form lintas situs tidak dapat dikirim.
 * - **CSP ketat.** Tidak ada skrip inline maupun skrip dari luar; jawaban model yang
 *   berisi HTML tidak dapat menjalankan apa pun.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { ServerEvent } from '../protocol.ts'
import { MAX_IMAGE_BYTES, type ImageAttachment } from '@boo/core'
import type { WebAssets } from './assets.ts'
import { ControllerError, type WebController } from './controller.ts'

const MAX_BODY_BYTES = 1024 * 1024
const HEARTBEAT_MS = 15_000

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
}

export interface WebServer {
  url: string
  /** Alamat dengan token, untuk dibuka di browser. */
  openUrl: string
  token: string
  port: number
  close(): Promise<void>
}

export interface WebServerOptions {
  controller: WebController
  assets: WebAssets
  port?: number
  /** Untuk test; bawaannya token acak 32 byte. */
  token?: string
}

function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

function send(response: ServerResponse, status: number, body: string | Buffer, type: string, extra: Record<string, string> = {}): void {
  response.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, 'Cache-Control': 'no-store', ...extra })
  response.end(body)
}

function json(response: ServerResponse, status: number, value: unknown): void {
  send(response, status, JSON.stringify(value), 'application/json; charset=utf-8')
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!(request.headers['content-type'] ?? '').startsWith('application/json')) {
    throw new ControllerError('Content-Type harus application/json.', 415)
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) throw new ControllerError('Permintaan terlalu besar.', 413)
    chunks.push(chunk as Buffer)
  }
  if (!size) return {}
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  } catch {
    throw new ControllerError('Badan permintaan bukan JSON yang sah.')
  }
}

async function readBinary(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += (chunk as Buffer).length
    if (size > MAX_IMAGE_BYTES) throw new ControllerError(`Gambar melebihi batas ${MAX_IMAGE_BYTES / 1024 / 1024} MiB.`, 413)
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

function attachments(value: unknown): ImageAttachment[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new ControllerError('Daftar attachment tidak sah.')
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object') throw new ControllerError('Attachment tidak sah.')
    const item = entry as Record<string, unknown>
    if (typeof item.id !== 'string' || typeof item.name !== 'string' || typeof item.mediaType !== 'string' || typeof item.ref !== 'string' || typeof item.bytes !== 'number') {
      throw new ControllerError('Attachment tidak sah.')
    }
    return item as unknown as ImageAttachment
  })
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

async function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve((server.address() as AddressInfo).port)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, '127.0.0.1')
  })
}

export async function startWebServer({ controller, assets, port = 0, token = randomBytes(32).toString('hex') }: WebServerOptions): Promise<WebServer> {
  let actualPort = 0
  const streams = new Set<ServerResponse>()

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      const status = error instanceof ControllerError ? error.status : 500
      const message = error instanceof Error ? error.message : 'Terjadi kesalahan.'
      if (!response.headersSent) json(response, status, { error: message })
      else response.end()
    })
  })

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const allowedHosts = [`127.0.0.1:${actualPort}`, `localhost:${actualPort}`]
    if (!allowedHosts.includes(request.headers.host ?? '')) {
      send(response, 421, 'Host tidak dikenal.', 'text/plain; charset=utf-8')
      return
    }

    const url = new URL(request.url ?? '/', `http://${request.headers.host}`)
    const method = request.method ?? 'GET'

    // Aset halaman tidak memuat rahasia apa pun; token dibutuhkan untuk API.
    if (method === 'GET' && !url.pathname.startsWith('/api/')) {
      switch (url.pathname) {
        case '/':
        case '/index.html':
          send(response, 200, assets.html, 'text/html; charset=utf-8')
          return
        case '/app.js':
          send(response, 200, assets.js, 'text/javascript; charset=utf-8')
          return
        case '/app.css':
          send(response, 200, assets.css, 'text/css; charset=utf-8')
          return
        case '/logo.png':
          send(response, 200, assets.logo, 'image/png', { 'Cache-Control': 'max-age=86400' })
          return
        default:
          send(response, 404, 'Tidak ditemukan.', 'text/plain; charset=utf-8')
          return
      }
    }

    const authorization = request.headers.authorization ?? ''
    if (!authorization.startsWith('Bearer ') || !sameToken(authorization.slice(7), token)) {
      json(response, 401, { error: 'Token tidak sah. Buka tautan yang dicetak di terminal.' })
      return
    }
    if (method !== 'GET') {
      const origin = request.headers.origin
      if (origin && !allowedHosts.some((host) => origin === `http://${host}`)) {
        json(response, 403, { error: 'Origin tidak diizinkan.' })
        return
      }
    }

    const route = `${method} ${url.pathname}`
    switch (route) {
      case 'GET /api/events': {
        response.writeHead(200, {
          ...SECURITY_HEADERS,
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
        })
        streams.add(response)
        const write = (event: ServerEvent) => response.write(`data: ${JSON.stringify(event)}\n\n`)
        const unsubscribe = controller.subscribe(write)
        const heartbeat = setInterval(() => response.write(': detak\n\n'), HEARTBEAT_MS)
        request.on('close', () => {
          clearInterval(heartbeat)
          unsubscribe()
          streams.delete(response)
        })
        return
      }
      case 'POST /api/submit': {
        const body = await readJson(request)
        controller.submit(text(body.text), attachments(body.attachments))
        json(response, 202, { ok: true })
        return
      }
      case 'POST /api/attachments': {
        const mediaType = request.headers['content-type'] ?? ''
        const encodedName = request.headers['x-boo-filename']
        let name = 'gambar'
        if (typeof encodedName === 'string') {
          try { name = decodeURIComponent(encodedName) } catch { throw new ControllerError('Nama attachment tidak sah.') }
        }
        const attachment = controller.uploadImage(name, mediaType, await readBinary(request))
        json(response, 201, { attachment })
        return
      }
      case 'POST /api/cancel':
        await readJson(request)
        controller.cancel()
        json(response, 200, { ok: true })
        return
      case 'POST /api/answer': {
        const body = await readJson(request)
        const accepted = controller.answer(text(body.questionId), text(body.optionId), text(body.text))
        json(response, accepted ? 200 : 409, accepted ? { ok: true } : { error: 'Pertanyaan itu sudah tidak berlaku.' })
        return
      }
      case 'POST /api/queue/clear':
        await readJson(request)
        controller.clearQueue()
        json(response, 200, { ok: true })
        return
      case 'GET /api/sessions':
        json(response, 200, { sessions: controller.sessions() })
        return
      case 'POST /api/session/new':
        await readJson(request)
        controller.newSession()
        json(response, 200, { ok: true })
        return
      case 'POST /api/session/resume': {
        const body = await readJson(request)
        controller.resumeSession(text(body.id))
        json(response, 200, { ok: true })
        return
      }
      case 'POST /api/session/fork':
        await readJson(request)
        controller.forkSession()
        json(response, 200, { ok: true })
        return
      case 'POST /api/session/rewind': {
        const body = await readJson(request)
        const turn = typeof body.turn === 'number' ? body.turn : undefined
        // Pemilih interaktif masuk antrean normal agar tidak berlomba dengan task
        // yang mungkin dikirim dari tab lain ketika pertanyaannya dijawab.
        if (turn === undefined) {
          controller.submit('/rewind')
          json(response, 202, { ok: true })
        } else {
          await controller.rewindSession(turn)
          json(response, 200, { ok: true })
        }
        return
      }
      case 'GET /api/models':
        json(response, 200, { families: await controller.models() })
        return
      case 'POST /api/model': {
        const body = await readJson(request)
        controller.setModel(text(body.modelId), typeof body.effort === 'string' ? body.effort : null)
        json(response, 200, { ok: true })
        return
      }
      case 'GET /api/specs':
        json(response, 200, { specs: controller.specs() })
        return
      case 'POST /api/spec/open': {
        const body = await readJson(request)
        controller.openSpec(text(body.name))
        json(response, 200, { ok: true })
        return
      }
      default:
        json(response, 404, { error: 'Tidak ditemukan.' })
    }
  }

  actualPort = await listen(server, port)
  const url = `http://127.0.0.1:${actualPort}/`
  return {
    url,
    // Token di fragmen: tidak pernah dikirim ke server dalam permintaan halaman atau tercatat di log.
    openUrl: `${url}#token=${token}`,
    token,
    port: actualPort,
    close: () => new Promise((resolve) => {
      for (const stream of streams) stream.end()
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
}
