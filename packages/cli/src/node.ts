import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { callComputerBridge, generateNodeToken, loadComputerBridge, loadRemoteNodes, pairRemoteNode, REMOTE_NODE_PROTOCOL, removeRemoteNode, safeRemoteNodeUrl, type ComputerAction, type ComputerKey } from '@boo/core'

export const NODE_USAGE = `boo-code node — hub perangkat Boo

  boo-code node list
  boo-code node pair --id laptop --label "Laptop" --url https://host:7443 --token <token>
  boo-code node remove <id>
  boo-code node serve [--host 127.0.0.1] [--port 7443]
                       [--cert cert.pem --key key.pem] [--token <token>]

HTTP hanya diizinkan pada loopback. Alamat jaringan wajib HTTPS. Node hanya
mengekspos computer-use allowlist; tidak ada remote shell atau filesystem bebas.`

function option(args: readonly string[], name: string): string | undefined {
  const inline = args.find((arg) => arg.startsWith(`${name}=`))
  if (inline) return inline.slice(name.length + 1)
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

function loopback(host: string): boolean { return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host) }

function authenticated(header: string | undefined, token: string): boolean {
  const provided = header?.startsWith('Bearer ') ? header.slice(7) : ''
  const left = Buffer.from(provided)
  const right = Buffer.from(token)
  return left.length === right.length && timingSafeEqual(left, right)
}

function send(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' })
  response.end(body)
}

async function bodyOf(request: IncomingMessage): Promise<unknown> {
  let body = ''
  for await (const chunk of request) {
    body += chunk.toString()
    if (Buffer.byteLength(body) > 32 * 1024) throw new Error('Request terlalu besar.')
  }
  return JSON.parse(body)
}

function computerRequest(value: unknown): { version: 1; action: ComputerAction; ref?: string; text?: string; key?: ComputerKey; maxElements?: number } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const item = value as Record<string, unknown>
  const actions = new Set<ComputerAction>(['status', 'snapshot', 'click', 'type', 'press'])
  if (typeof item.action !== 'string' || !actions.has(item.action as ComputerAction)) return null
  if (item.ref !== undefined && (typeof item.ref !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(item.ref))) return null
  if (item.text !== undefined && (typeof item.text !== 'string' || !item.text || item.text.length > 4_000 || item.text.includes('\0'))) return null
  const keys = new Set(['Enter', 'Escape', 'Tab', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backspace', 'Delete'])
  if (item.key !== undefined && (typeof item.key !== 'string' || !keys.has(item.key))) return null
  if (item.maxElements !== undefined && (typeof item.maxElements !== 'number' || !Number.isInteger(item.maxElements) || item.maxElements < 1 || item.maxElements > 500)) return null
  if (['click', 'type', 'press'].includes(item.action as string) && typeof item.ref !== 'string') return null
  if (item.action === 'type' && typeof item.text !== 'string') return null
  if (item.action === 'press' && typeof item.key !== 'string') return null
  return { version: 1, action: item.action as ComputerAction, ...(typeof item.ref === 'string' ? { ref: item.ref } : {}), ...(typeof item.text === 'string' ? { text: item.text } : {}), ...(typeof item.key === 'string' ? { key: item.key as ComputerKey } : {}), ...(typeof item.maxElements === 'number' ? { maxElements: item.maxElements } : {}) }
}

async function serve(args: readonly string[], home: string): Promise<number> {
  const host = option(args, '--host') ?? '127.0.0.1'
  const portText = option(args, '--port') ?? '7443'
  if (!/^\d+$/.test(portText) || Number(portText) > 65_535) throw new Error('Port node tidak sah.')
  const port = Number(portText)
  const cert = option(args, '--cert')
  const key = option(args, '--key')
  if (Boolean(cert) !== Boolean(key)) throw new Error('--cert dan --key harus diberikan bersama.')
  if (!loopback(host) && !cert) throw new Error('Remote node non-loopback wajib memakai HTTPS (--cert dan --key).')
  const token = option(args, '--token') ?? process.env.BOO_NODE_TOKEN ?? generateNodeToken()
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new Error('Token node harus base64url 32–256 karakter.')
  const bridge = loadComputerBridge(home)
  if (!bridge) throw new Error('Bridge computer use belum dikonfigurasi di ~/.boo/computer.json.')

  const handler = async (request: IncomingMessage, response: ServerResponse) => {
    response.setHeader('X-Content-Type-Options', 'nosniff')
    if (request.url !== '/v1/computer' || request.method !== 'POST') return send(response, 404, { ok: false, message: 'Not found.' })
    if (request.headers['x-boo-node-protocol'] !== String(REMOTE_NODE_PROTOCOL)) return send(response, 400, { ok: false, message: 'Versi protokol tidak cocok.' })
    if (!authenticated(request.headers.authorization, token)) return send(response, 401, { ok: false, message: 'Token node ditolak.' })
    try {
      const parsed = computerRequest(await bodyOf(request))
      if (!parsed) return send(response, 400, { ok: false, message: 'Request computer use tidak sah.' })
      const result = await callComputerBridge(bridge, parsed)
      send(response, result.ok ? 200 : 409, result)
    } catch (error) { send(response, 500, { ok: false, message: error instanceof Error ? error.message.slice(0, 500) : 'Node gagal.' }) }
  }
  const server = cert && key
    ? createHttpsServer({ cert: readFileSync(cert), key: readFileSync(key) }, (request, response) => { void handler(request, response) })
    : createHttpServer((request, response) => { void handler(request, response) })
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(port, host, resolvePromise)
  })
  const address = server.address()
  const actualPort = address && typeof address === 'object' ? address.port : port
  const protocol = cert ? 'https' : 'http'
  console.log(`Boo node aktif: ${protocol}://${host}:${actualPort}`)
  console.log(`Pair token: ${token}`)
  console.log('Token hanya ditampilkan pada terminal node ini. Tekan Ctrl-C untuk berhenti.')
  await new Promise<void>((resolvePromise) => {
    const stop = () => server.close(() => resolvePromise())
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
  return 0
}

export async function runNodeCommand(args: readonly string[], home = homedir()): Promise<number> {
  const command = args[0] ?? 'list'
  try {
    if (command === '--help' || command === '-h' || command === 'help') { console.log(NODE_USAGE); return 0 }
    if (command === 'list') {
      const nodes = loadRemoteNodes(home).nodes
      if (!nodes.length) console.log('Belum ada remote node.')
      for (const node of nodes) console.log(`${node.id}  ${node.label}  ${new URL(node.url).host}`)
      return 0
    }
    if (command === 'pair') {
      const id = option(args, '--id')
      const label = option(args, '--label') ?? id
      const url = option(args, '--url')
      const token = option(args, '--token') ?? process.env.BOO_NODE_TOKEN
      if (!id || !label || !url || !token || !safeRemoteNodeUrl(url)) throw new Error('Pair membutuhkan --id, --url HTTPS/loopback, dan --token (atau BOO_NODE_TOKEN).')
      const node = pairRemoteNode({ id, label, url, token }, home)
      console.log(`Node ${node.id} (${node.label}) dipasangkan. Token disimpan privat dan tidak ditampilkan lagi.`)
      return 0
    }
    if (command === 'remove') {
      const id = args[1]
      if (!id || !removeRemoteNode(id, home)) throw new Error('Remote node tidak ditemukan.')
      console.log(`Node ${id} dihapus.`)
      return 0
    }
    if (command === 'serve') return await serve(args.slice(1), home)
    throw new Error(`Subcommand node tidak dikenal: ${command}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Perintah node gagal.')
    console.error('Pakai `boo-code node --help` untuk bantuan.')
    return 2
  }
}
