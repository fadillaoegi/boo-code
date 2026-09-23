/** Paired remote device nodes. Tokens remain local and are never returned to the model. */

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { ComputerAction, ComputerKey, ComputerResponse } from '../tools/computer.ts'

export interface RemoteNodeDefinition {
  id: string
  label: string
  url: string
  token: string
}

export interface RemoteNodeFile { version: 1; nodes: RemoteNodeDefinition[] }
export interface RemoteComputerRequest {
  action: ComputerAction
  ref?: string
  text?: string
  key?: ComputerKey
  maxElements?: number
}

export const REMOTE_NODES_FILE = 'nodes.json'
export const REMOTE_NODE_PROTOCOL = 1
const MAX_CONFIG_BYTES = 256 * 1024
const MAX_RESPONSE_BYTES = 1024 * 1024
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/

function loopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '::1' || /^127(?:\.\d{1,3}){3}$/.test(hostname)
}

export function safeRemoteNodeUrl(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.username || url.password || url.search || url.hash) return null
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback(url.hostname))) return null
    url.pathname = url.pathname.replace(/\/$/, '') || ''
    return url.href.replace(/\/$/, '')
  } catch { return null }
}

function parseNode(value: unknown): RemoteNodeDefinition | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const item = value as Record<string, unknown>
  const url = typeof item.url === 'string' ? safeRemoteNodeUrl(item.url) : null
  if (typeof item.id !== 'string' || !ID.test(item.id) || typeof item.label !== 'string' || !item.label.trim()
    || item.label.length > 120 || !url || typeof item.token !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(item.token)) return null
  return { id: item.id, label: item.label.slice(0, 120), url, token: item.token }
}

export function loadRemoteNodes(home = homedir()): RemoteNodeFile {
  try {
    const path = join(home, '.boo', REMOTE_NODES_FILE)
    const raw = readFileSync(path, 'utf8')
    if (Buffer.byteLength(raw) > MAX_CONFIG_BYTES) return { version: 1, nodes: [] }
    const parsed = JSON.parse(raw) as { version?: unknown; nodes?: unknown }
    if (parsed.version !== 1 || !Array.isArray(parsed.nodes)) return { version: 1, nodes: [] }
    return { version: 1, nodes: parsed.nodes.slice(0, 100).flatMap((item) => {
      const node = parseNode(item)
      return node ? [node] : []
    }) }
  } catch { return { version: 1, nodes: [] } }
}

export function saveRemoteNodes(file: RemoteNodeFile, home = homedir()): void {
  const path = join(home, '.boo', REMOTE_NODES_FILE)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify({ version: 1, nodes: file.nodes.slice(0, 100) }, null, 2)}\n`, { mode: 0o600 })
  chmodSync(temporary, 0o600)
  renameSync(temporary, path)
  chmodSync(path, 0o600)
}

export function pairRemoteNode(input: RemoteNodeDefinition, home = homedir()): RemoteNodeDefinition {
  const node = parseNode(input)
  if (!node) throw new Error('Konfigurasi remote node tidak sah. Gunakan HTTPS, atau HTTP loopback untuk development.')
  const file = loadRemoteNodes(home)
  const index = file.nodes.findIndex((item) => item.id === node.id)
  if (index === -1) file.nodes.push(node)
  else file.nodes[index] = node
  saveRemoteNodes(file, home)
  return node
}

export function removeRemoteNode(id: string, home = homedir()): boolean {
  const file = loadRemoteNodes(home)
  const next = file.nodes.filter((node) => node.id !== id)
  if (next.length === file.nodes.length) return false
  saveRemoteNodes({ version: 1, nodes: next }, home)
  return true
}

export function generateNodeToken(): string { return randomBytes(32).toString('base64url') }

function remoteNode(file: RemoteNodeFile, id: string): RemoteNodeDefinition {
  const matches = file.nodes.filter((node) => node.id === id || node.id.startsWith(id))
  if (matches.length !== 1) throw new Error(matches.length ? 'Prefix remote node ambigu.' : 'Remote node tidak ditemukan.')
  return matches[0]
}

export async function callRemoteNode(
  id: string,
  request: RemoteComputerRequest,
  options: { home?: string; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ComputerResponse> {
  const node = remoteNode(loadRemoteNodes(options.home), id)
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 15_000)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  let response: Response
  try {
    response = await fetch(`${node.url}/v1/computer`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${node.token}`, 'Content-Type': 'application/json', 'X-Boo-Node-Protocol': String(REMOTE_NODE_PROTOCOL) },
      body: JSON.stringify(request),
      signal,
    })
  } catch (error) {
    throw new Error(`Remote node ${node.label} tidak dapat dihubungi: ${error instanceof Error ? error.message : 'kesalahan jaringan'}`, { cause: error })
  }
  const body = await response.text()
  if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) throw new Error('Respons remote node terlalu besar.')
  let parsed: unknown
  try { parsed = JSON.parse(body) } catch { throw new Error(`Remote node mengembalikan respons tidak sah (HTTP ${response.status}).`) }
  if (!response.ok) {
    const message = parsed && typeof parsed === 'object' && typeof (parsed as { message?: unknown }).message === 'string' ? (parsed as { message: string }).message : `HTTP ${response.status}`
    throw new Error(`Remote node menolak request: ${message.slice(0, 500)}`)
  }
  if (!parsed || typeof parsed !== 'object' || typeof (parsed as { ok?: unknown }).ok !== 'boolean' || typeof (parsed as { message?: unknown }).message !== 'string') {
    throw new Error('Respons remote node tidak memenuhi protokol Boo.')
  }
  return parsed as ComputerResponse
}
