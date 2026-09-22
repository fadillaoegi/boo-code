import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ChildProcess } from 'node:child_process'
import type { Tool } from '../domain/tool.ts'
import type { SandboxPolicy } from './sandbox.ts'
import { inspectSandbox } from './sandbox.ts'
import { OutputBuffer, startCommand, terminate } from './shell.ts'

export const MCP_CONFIG_PATH = '.boo/mcp.json'
const MAX_CONFIG_BYTES = 64 * 1024
const MAX_MCP_OUTPUT = 60_000
const MAX_HTTP_RESPONSE_BYTES = 8 * 1024 * 1024
const MODERN_PROTOCOL_VERSION = '2026-07-28'
const LEGACY_PROTOCOL_VERSION = '2025-11-25'
const RESERVED_HTTP_HEADERS = new Set([
  'accept', 'connection', 'content-length', 'content-type', 'host', 'mcp-method',
  'mcp-name', 'mcp-protocol-version', 'mcp-session-id', 'origin', 'transfer-encoding',
])

export interface McpServerDefinition {
  name: string
  transport: 'stdio' | 'http'
  command: string
  args: string[]
  url?: string
  headers: Record<string, string>
  source: 'global' | 'project'
  label: string
}

interface RpcMessage {
  jsonrpc: '2.0'
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
}

function projectRoot(workspace: string): string {
  let directory = resolve(workspace)
  for (;;) {
    if (existsSync(join(directory, '.git'))) return directory
    const parent = dirname(directory)
    if (parent === directory) return resolve(workspace)
    directory = parent
  }
}

function directoriesBetween(root: string, workspace: string): string[] {
  const found = [root]
  let current = root
  const rest = relative(root, workspace)
  if (!rest) return found
  for (const segment of rest.split(sep)) { current = join(current, segment); found.push(current) }
  return found
}

function isInside(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)
}

function readConfig(path: string, allowedRoot: string, source: McpServerDefinition['source'], label: string): McpServerDefinition[] {
  let real: string
  try {
    real = realpathSync(path)
    const info = statSync(real)
    if (!info.isFile() || info.size > MAX_CONFIG_BYTES || !isInside(real, realpathSync(allowedRoot))) return []
  } catch { return [] }
  let parsed: unknown
  try { parsed = JSON.parse(readFileSync(real, 'utf8')) } catch { return [] }
  const servers = parsed && typeof parsed === 'object' ? (parsed as { servers?: unknown }).servers : null
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return []
  const definitions: McpServerDefinition[] = []
  for (const [name, value] of Object.entries(servers as Record<string, unknown>)) {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(name) || !value || typeof value !== 'object') continue
    const config = value as { command?: unknown; args?: unknown; url?: unknown; headers?: unknown; enabled?: unknown }
    if (config.enabled === false) continue
    if (typeof config.url === 'string') {
      const url = safeMcpUrl(config.url)
      const headers = safeHeaders(config.headers)
      if (!url || headers === null || config.command !== undefined || config.args !== undefined) continue
      definitions.push({ name, transport: 'http', command: '', args: [], url, headers, source, label })
      continue
    }
    if (typeof config.command !== 'string' || !config.command.trim() || /[\r\n\0]/.test(config.command)) continue
    if (config.args !== undefined && (!Array.isArray(config.args) || config.args.some((arg) => typeof arg !== 'string' || /[\r\n\0]/.test(arg)))) continue
    definitions.push({ name, transport: 'stdio', command: config.command, args: (config.args as string[] | undefined) ?? [], headers: {}, source, label })
  }
  return definitions
}

function safeMcpUrl(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.username || url.password || url.hash) return null
    const loopback = url.hostname === 'localhost' || url.hostname === '::1' || /^127(?:\.\d{1,3}){3}$/.test(url.hostname)
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return null
    return url.href
  } catch {
    return null
  }
}

function safeHeaders(value: unknown): Record<string, string> | null {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const headers: Record<string, string> = {}
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    const lower = name.toLowerCase()
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || RESERVED_HTTP_HEADERS.has(lower)) return null
    if (typeof raw !== 'string' || /[\r\n\0]/.test(raw)) return null
    headers[name] = raw
  }
  return headers
}

/** Konfigurasi terdekat menimpa global; membaca konfigurasi tidak menjalankan server. */
export function loadMcpServers(workspace: string, home?: string): McpServerDefinition[] {
  const root = resolve(workspace)
  const byName = new Map<string, McpServerDefinition>()
  if (home) {
    const globalRoot = join(home, '.boo')
    for (const server of readConfig(join(globalRoot, 'mcp.json'), globalRoot, 'global', '~/.boo/mcp.json')) byName.set(server.name, server)
  }
  const top = projectRoot(root)
  for (const directory of directoriesBetween(top, root)) {
    const config = join(directory, MCP_CONFIG_PATH)
    const label = relative(root, config).split(sep).join('/')
    for (const server of readConfig(config, top, 'project', label)) byName.set(server.name, server)
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

function quote(value: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return `"${value.replace(/"/g, '""')}"`
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

export function mcpCommand(server: McpServerDefinition): string {
  if (server.transport === 'http') return server.url ?? ''
  return [server.command, ...server.args].map((part) => quote(part)).join(' ')
}

interface Pending {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: NodeJS.Timeout
  cleanup(): void
}

interface McpClientConnection {
  initialize(timeoutMs: number, signal?: AbortSignal): Promise<void>
  request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown>
  close(): Promise<void>
}

class StdioMcpConnection implements McpClientConnection {
  private readonly child: ChildProcess
  private readonly root: { uri: string; name: string }
  private readonly pending = new Map<number, Pending>()
  private readonly stderr = new OutputBuffer(2_000, 6_000)
  private buffer = ''
  private nextId = 1
  private closed = false

  constructor(command: string, workspace: string, sandbox?: SandboxPolicy) {
    this.root = { uri: pathToFileURL(resolve(workspace)).href, name: workspace.split(sep).filter(Boolean).at(-1) ?? 'workspace' }
    this.child = startCommand(command, { cwd: workspace, sandbox, stdin: 'pipe' })
    this.child.stdout?.on('data', (chunk: string | Buffer) => this.consume(chunk.toString()))
    this.child.stderr?.on('data', (chunk: string | Buffer) => this.stderr.append(chunk.toString()))
    this.child.once('error', (error) => this.failAll(new Error(`MCP server gagal dimulai: ${error.message}`, { cause: error })))
    this.child.once('close', (code) => {
      if (!this.closed) this.failAll(new Error(`MCP server berhenti (exit ${code ?? '?'}). ${this.stderr.toString()}`.trim()))
    })
  }

  private consume(chunk: string): void {
    this.buffer += chunk
    for (;;) {
      const newline = this.buffer.indexOf('\n')
      if (newline === -1) return
      const line = this.buffer.slice(0, newline).replace(/\r$/, '')
      this.buffer = this.buffer.slice(newline + 1)
      if (!line.trim()) continue
      try { this.handle(JSON.parse(line) as RpcMessage) } catch (error) {
        this.failAll(new Error('MCP server mengirim JSON yang tidak valid melalui stdout.', { cause: error }))
      }
    }
  }

  private handle(message: RpcMessage): void {
    if (message.method && message.id !== undefined) {
      let result: unknown = {}
      if (message.method === 'roots/list') result = { roots: [this.root] }
      else if (message.method.startsWith('sampling/') || message.method.startsWith('elicitation/')) {
        this.send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Boo tidak mengizinkan MCP server meminta sampling atau elicitation.' } })
        return
      }
      this.send({ jsonrpc: '2.0', id: message.id, result })
      return
    }
    if (typeof message.id !== 'number') return
    const item = this.pending.get(message.id)
    if (!item) return
    this.pending.delete(message.id)
    clearTimeout(item.timer)
    item.cleanup()
    if (message.error) item.reject(new Error(`MCP ${message.error.code ?? ''}: ${message.error.message ?? 'request gagal'}`.trim()))
    else item.resolve(message.result)
  }

  private send(message: RpcMessage): void {
    if (!this.child.stdin?.writable) throw new Error('stdin MCP server tidak tersedia.')
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  notify(method: string, params?: unknown): void { this.send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }) }

  async initialize(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    await this.request('initialize', {
      protocolVersion: LEGACY_PROTOCOL_VERSION,
      capabilities: { roots: { listChanged: false } },
      clientInfo: { name: 'Boo Code', version: '0.1.0' },
    }, timeoutMs, signal)
    this.notify('notifications/initialized')
  }

  request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(new Error('Permintaan MCP dibatalkan.'))
    const id = this.nextId++
    return new Promise((resolveRequest, reject) => {
      const onAbort = () => {
        const item = this.pending.get(id)
        if (!item) return
        this.pending.delete(id)
        clearTimeout(item.timer)
        item.cleanup()
        reject(new Error('Permintaan MCP dibatalkan.'))
      }
      const timer = setTimeout(() => {
        this.pending.delete(id)
        signal?.removeEventListener('abort', onAbort)
        reject(new Error(`MCP server tidak menjawab ${method} dalam ${Math.ceil(timeoutMs / 1_000)} detik.`))
      }, timeoutMs)
      const cleanup = () => signal?.removeEventListener('abort', onAbort)
      this.pending.set(id, { resolve: resolveRequest, reject, timer, cleanup })
      signal?.addEventListener('abort', onAbort, { once: true })
      try { this.send({ jsonrpc: '2.0', id, method, params }) } catch (error) {
        this.pending.delete(id); clearTimeout(timer); cleanup(); reject(error as Error)
      }
    })
  }

  private failAll(error: Error): void {
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.cleanup(); item.reject(error) }
    this.pending.clear()
  }

  async close(): Promise<void> {
    this.closed = true
    this.child.stdin?.end()
    terminate(this.child, 500)
  }
}

class McpHttpError extends Error {
  readonly status: number
  readonly rpc?: RpcMessage
  constructor(message: string, status: number, rpc?: RpcMessage) {
    super(message)
    this.status = status
    this.rpc = rpc
  }
}

function loopbackUrl(url: URL): boolean {
  return url.hostname === 'localhost' || url.hostname === '::1' || /^127(?:\.\d{1,3}){3}$/.test(url.hostname)
}

function headerValue(value: string): string {
  const plain = /^[\x20-\x7e\t]+$/.test(value) && value.trim() === value && !(value.startsWith('=?base64?') && value.endsWith('?='))
  return plain ? value : `=?base64?${Buffer.from(value).toString('base64')}?=`
}

interface HeaderBinding { path: string[]; header: string; type: 'string' | 'integer' | 'boolean' }
interface CachedMcpTool { name: string; headers: HeaderBinding[] }

function toolHeaderBindings(schema: unknown): HeaderBinding[] | null {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return []
  const bindings: HeaderBinding[] = []
  const names = new Set<string>()
  let annotations = 0
  const countAnnotations = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const item of node) countAnnotations(item)
      return
    }
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'x-mcp-header') annotations += 1
      else countAnnotations(child)
    }
  }
  countAnnotations(schema)
  function visit(node: unknown, path: string[]): boolean {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return true
    const object = node as Record<string, unknown>
    if (object['x-mcp-header'] !== undefined) {
      const header = object['x-mcp-header']
      const type = object.type
      if (typeof header !== 'string' || !header || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header)) return false
      if (type !== 'string' && type !== 'integer' && type !== 'boolean') return false
      if (!path.length || names.has(header.toLowerCase())) return false
      names.add(header.toLowerCase())
      bindings.push({ path, header, type })
    }
    if (object.properties !== undefined) {
      if (!object.properties || typeof object.properties !== 'object' || Array.isArray(object.properties)) return false
      for (const [name, child] of Object.entries(object.properties as Record<string, unknown>)) {
        if (!visit(child, [...path, name])) return false
      }
    }
    return true
  }
  return visit(schema, []) && annotations === bindings.length ? bindings : null
}

function valueAt(root: unknown, path: readonly string[]): unknown {
  let current = root
  for (const segment of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

async function readSseResponse(
  response: Response,
  requestId: number,
  onMessage: (message: RpcMessage) => Promise<void>,
): Promise<RpcMessage> {
  if (!response.body) throw new Error('MCP HTTP mengembalikan SSE tanpa body.')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let bytes = 0
  let data: string[] = []
  let answer: RpcMessage | null = null
  const dispatch = async () => {
    if (!data.length) return
    const raw = data.join('\n')
    data = []
    let message: RpcMessage
    try { message = JSON.parse(raw) as RpcMessage } catch (error) {
      throw new Error('MCP HTTP mengirim event SSE dengan JSON tidak valid.', { cause: error })
    }
    if (message.id === requestId && !message.method) answer = message
    else await onMessage(message)
  }
  const consume = async (final = false) => {
    const lines = buffer.split(/\r?\n/)
    buffer = final ? '' : lines.pop() ?? ''
    for (const line of lines) {
      if (!line) await dispatch()
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
      // comment, event, id, dan retry tidak diperlukan untuk response-scoped SSE.
    }
    if (final) await dispatch()
  }
  for (;;) {
    const part = await reader.read()
    if (part.done) break
    bytes += part.value.byteLength
    if (bytes > MAX_HTTP_RESPONSE_BYTES) {
      await reader.cancel()
      throw new Error('Respons MCP HTTP melebihi batas 8 MB.')
    }
    buffer += decoder.decode(part.value, { stream: true })
    await consume()
    if (answer) {
      await reader.cancel()
      return answer
    }
  }
  buffer += decoder.decode()
  await consume(true)
  if (!answer) throw new Error('Stream SSE MCP berakhir tanpa respons JSON-RPC.')
  return answer
}

class HttpMcpConnection implements McpClientConnection {
  private readonly server: McpServerDefinition
  private readonly endpoint: URL
  private readonly root: { uri: string; name: string }
  private nextId = 1
  private mode: 'unknown' | 'modern' | 'legacy' = 'unknown'
  private sessionId = ''
  private preloadedTools: unknown = undefined
  private readonly tools = new Map<string, CachedMcpTool>()

  constructor(server: McpServerDefinition, sandbox: SandboxPolicy | undefined, workspace = process.cwd()) {
    this.server = server
    this.endpoint = new URL(server.url ?? '')
    this.root = { uri: pathToFileURL(resolve(workspace)).href, name: workspace.split(sep).filter(Boolean).at(-1) ?? 'workspace' }
    const networkAllowed = sandbox?.mode === 'danger-full-access' || sandbox?.networkAccess === true
    if (!loopbackUrl(this.endpoint) && !networkAllowed) {
      throw new Error('MCP HTTP remote diblokir karena BOO_NETWORK_ACCESS belum diaktifkan.')
    }
  }

  async initialize(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    this.mode = 'modern'
    try {
      this.preloadedTools = await this.rawRequest('tools/list', {}, timeoutMs, signal)
      this.cacheTools(this.preloadedTools)
      return
    } catch (error) {
      if (!this.shouldFallBack(error)) throw error
    }

    this.mode = 'legacy'
    await this.rawRequest('initialize', {
      protocolVersion: LEGACY_PROTOCOL_VERSION,
      capabilities: { roots: { listChanged: false } },
      clientInfo: { name: 'Boo Code', version: '0.1.0' },
    }, timeoutMs, signal)
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, timeoutMs, signal)
  }

  private shouldFallBack(error: unknown): boolean {
    if (!(error instanceof McpHttpError)) return false
    if (error.rpc?.error?.code === -32022) {
      const supported = (error.rpc.error.data as { supported?: unknown } | undefined)?.supported
      return Array.isArray(supported) && supported.includes(LEGACY_PROTOCOL_VERSION)
    }
    if (error.rpc?.error && [-32020, -32601].includes(error.rpc.error.code ?? 0)) return error.status !== 404
    return [400, 404, 405].includes(error.status) && !error.rpc?.error
  }

  async request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    if (this.mode === 'unknown') throw new Error('Koneksi MCP HTTP belum diinisialisasi.')
    if (method === 'tools/list' && this.preloadedTools !== undefined) {
      const result = this.preloadedTools
      this.preloadedTools = undefined
      return result
    }
    if (this.mode === 'modern' && method === 'tools/call' && !this.tools.size) {
      this.cacheTools(await this.rawRequest('tools/list', {}, timeoutMs, signal))
    }
    if (this.mode === 'modern' && method === 'tools/call') {
      const name = params && typeof params === 'object' ? (params as { name?: unknown }).name : undefined
      if (typeof name !== 'string' || !this.tools.has(name)) throw new Error(`Tool MCP "${String(name ?? '')}" tidak ditemukan pada tools/list.`)
    }
    const result = await this.rawRequest(method, params, timeoutMs, signal)
    if (method === 'tools/list') this.cacheTools(result)
    return result
  }

  private cacheTools(result: unknown): void {
    this.tools.clear()
    const response = result && typeof result === 'object' ? result as { tools?: unknown } : {}
    if (!Array.isArray(response.tools)) return
    const valid: unknown[] = []
    for (const raw of response.tools) {
      if (!raw || typeof raw !== 'object' || typeof (raw as { name?: unknown }).name !== 'string') continue
      const tool = raw as { name: string; inputSchema?: unknown }
      const headers = toolHeaderBindings(tool.inputSchema)
      if (headers === null) continue
      this.tools.set(tool.name, { name: tool.name, headers })
      valid.push(raw)
    }
    response.tools.splice(0, response.tools.length, ...valid)
  }

  private modernParams(params: unknown): Record<string, unknown> {
    const base = params && typeof params === 'object' && !Array.isArray(params) ? params as Record<string, unknown> : {}
    return {
      ...base,
      _meta: {
        'io.modelcontextprotocol/protocolVersion': MODERN_PROTOCOL_VERSION,
        'io.modelcontextprotocol/clientInfo': { name: 'Boo Code', version: '0.1.0' },
        'io.modelcontextprotocol/clientCapabilities': {},
      },
    }
  }

  private requestHeaders(method: string, params: unknown): Record<string, string> {
    if (this.mode !== 'modern') return {}
    const headers: Record<string, string> = { 'Mcp-Method': method }
    const object = params && typeof params === 'object' ? params as { name?: unknown; uri?: unknown; arguments?: unknown } : {}
    const named = typeof object.name === 'string' ? object.name : typeof object.uri === 'string' ? object.uri : undefined
    if (named !== undefined) headers['Mcp-Name'] = headerValue(named)
    if (method === 'tools/call' && typeof object.name === 'string') {
      const tool = this.tools.get(object.name)
      for (const binding of tool?.headers ?? []) {
        const value = valueAt(object.arguments, binding.path)
        if (value === undefined || value === null) continue
        const valid = binding.type === 'string' && typeof value === 'string'
          || binding.type === 'boolean' && typeof value === 'boolean'
          || binding.type === 'integer' && typeof value === 'number' && Number.isSafeInteger(value)
        if (!valid) throw new Error(`Argument ${binding.path.join('.')} tidak valid untuk header MCP ${binding.header}.`)
        headers[`Mcp-Param-${binding.header}`] = headerValue(String(value))
      }
    }
    return headers
  }

  private async rawRequest(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    const id = this.nextId++
    const bodyParams = this.mode === 'modern' ? this.modernParams(params) : params
    const message: RpcMessage = { jsonrpc: '2.0', id, method, params: bodyParams }
    const response = await this.post(message, timeoutMs, signal, this.requestHeaders(method, params))
    if (!response) throw new Error(`MCP HTTP tidak mengembalikan respons untuk ${method}.`)
    if (response.error) {
      throw new McpHttpError(`MCP ${response.error.code ?? ''}: ${response.error.message ?? 'request gagal'}`.trim(), 200, response)
    }
    return response.result
  }

  private async post(message: RpcMessage, timeoutMs: number, signal?: AbortSignal, extraHeaders: Record<string, string> = {}): Promise<RpcMessage | null> {
    const controller = new AbortController()
    const onAbort = () => controller.abort(signal?.reason)
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
    try {
      const headers: Record<string, string> = {
        ...this.server.headers,
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        ...(this.mode === 'modern' ? { 'MCP-Protocol-Version': MODERN_PROTOCOL_VERSION } : {}),
        ...(this.mode === 'legacy' && this.sessionId ? { 'MCP-Protocol-Version': LEGACY_PROTOCOL_VERSION, 'Mcp-Session-Id': this.sessionId } : {}),
        ...extraHeaders,
      }
      const response = await fetch(this.endpoint, {
        method: 'POST', headers, body: JSON.stringify(message), signal: controller.signal, redirect: 'error',
      })
      const session = response.headers.get('mcp-session-id')
      if (session) {
        if (!/^[\x21-\x7e]+$/.test(session)) throw new Error('MCP server mengirim session ID tidak valid.')
        this.sessionId = session
      }
      if (response.status === 202) return null
      const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
      let rpc: RpcMessage | undefined
      let fallbackText = ''
      if (type === 'text/event-stream' && typeof message.id === 'number') {
        rpc = await readSseResponse(response, message.id, (incoming) => this.handleServerMessage(incoming, timeoutMs, signal))
      } else {
        fallbackText = await response.text()
        if (Buffer.byteLength(fallbackText) > MAX_HTTP_RESPONSE_BYTES) throw new Error('Respons MCP HTTP melebihi batas 8 MB.')
        if (fallbackText.trim()) {
          try { rpc = JSON.parse(fallbackText) as RpcMessage } catch {
            if (response.ok) throw new Error('MCP HTTP mengembalikan JSON tidak valid.')
          }
        }
      }
      if (!response.ok) {
        const detail = rpc?.error?.message || fallbackText.trim().slice(0, 500) || response.statusText
        throw new McpHttpError(`MCP HTTP ${response.status}: ${detail}`, response.status, rpc)
      }
      return rpc ?? null
    } catch (error) {
      if (controller.signal.aborted) {
        if (signal?.aborted) throw new Error('Permintaan MCP dibatalkan.', { cause: error })
        throw new Error(`MCP server tidak menjawab dalam ${Math.ceil(timeoutMs / 1_000)} detik.`, { cause: error })
      }
      throw error
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  private async handleServerMessage(message: RpcMessage, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (!message.method || message.id === undefined) return
    let response: RpcMessage
    if (message.method === 'roots/list') response = { jsonrpc: '2.0', id: message.id, result: { roots: [this.root] } }
    else response = { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Boo tidak mengizinkan MCP server meminta sampling atau elicitation.' } }
    await this.post(response, timeoutMs, signal)
  }

  async close(): Promise<void> {
    if (!this.sessionId) return
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 2_000)
    try {
      await fetch(this.endpoint, {
        method: 'DELETE',
        headers: { ...this.server.headers, 'MCP-Protocol-Version': LEGACY_PROTOCOL_VERSION, 'Mcp-Session-Id': this.sessionId },
        signal: controller.signal,
        redirect: 'error',
      })
    } catch {
      // Penutupan session bersifat best effort; server boleh membalas 405.
    } finally {
      clearTimeout(timer)
    }
  }
}

async function withMcp<T>(
  workspace: string,
  server: McpServerDefinition,
  sandbox: SandboxPolicy | undefined,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  action: (connection: McpClientConnection) => Promise<T>,
): Promise<T> {
  const connection: McpClientConnection = server.transport === 'http'
    ? new HttpMcpConnection(server, sandbox, workspace)
    : new StdioMcpConnection(mcpCommand(server), workspace, sandbox)
  try {
    await connection.initialize(timeoutMs, signal)
    return await action(connection)
  } finally {
    await connection.close()
  }
}

function serverNamed(name: string, workspace: string, home?: string): McpServerDefinition {
  const server = loadMcpServers(workspace, home).find((entry) => entry.name === name)
  if (!server) throw new Error(`MCP server "${name}" tidak terdaftar. Gunakan list_mcp_servers.`)
  return server
}

function timeout(requested: unknown): number {
  const seconds = typeof requested === 'number' && Number.isFinite(requested) ? requested : 30
  return Math.max(3, Math.min(120, Math.round(seconds))) * 1_000
}

interface McpContent { type?: string; text?: string; data?: string; mimeType?: string; resource?: { uri?: string; text?: string; mimeType?: string } }

function formatMcpResult(result: unknown): { content: string; isError: boolean } {
  const response = result && typeof result === 'object' ? result as { content?: unknown; isError?: unknown; structuredContent?: unknown } : {}
  const blocks = Array.isArray(response.content) ? response.content as McpContent[] : []
  const output: string[] = []
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') output.push(block.text)
    else if (block.type === 'resource' && block.resource) output.push(`[resource ${block.resource.uri ?? ''}${block.resource.mimeType ? ` · ${block.resource.mimeType}` : ''}]${block.resource.text ? `\n${block.resource.text}` : ''}`)
    else if (block.type === 'image' || block.type === 'audio') output.push(`[${block.type} ${block.mimeType ?? ''} tidak dimasukkan sebagai base64 ke konteks]`)
    else output.push(`[blok MCP ${block.type ?? 'tidak dikenal'}]`)
  }
  if (response.structuredContent !== undefined) output.push(JSON.stringify(response.structuredContent, null, 2))
  const text = output.join('\n\n') || '(MCP server tidak mengembalikan content.)'
  return { content: text.length > MAX_MCP_OUTPUT ? `${text.slice(0, MAX_MCP_OUTPUT)}\n[… output MCP dipotong …]` : text, isError: response.isError === true }
}

function sandboxWarning(workspace: string, sandbox?: SandboxPolicy): string {
  const policy = sandbox ?? { mode: 'workspace-write' as const }
  const status = inspectSandbox(workspace, policy)
  return status.enforced || policy.mode === 'danger-full-access' ? '' : `Peringatan sandbox: ${status.reason}\n`
}

function transportWarning(server: McpServerDefinition, workspace: string, sandbox?: SandboxPolicy): string {
  return server.transport === 'stdio' ? sandboxWarning(workspace, sandbox) : ''
}

function serverSummary(server: McpServerDefinition): string {
  if (server.transport === 'http') {
    const headerNames = Object.keys(server.headers)
    return `${displayMcpUrl(server)}${headerNames.length ? ` · headers: ${headerNames.join(', ')}` : ''}`
  }
  return `${server.command} ${server.args.join(' ')}`.trim()
}

function serverDetail(server: McpServerDefinition): string {
  if (server.transport === 'http') {
    const headers = Object.keys(server.headers)
    return `POST ${displayMcpUrl(server)}${headers.length ? `\nheaders: ${headers.join(', ')} (nilai disembunyikan)` : ''}`
  }
  return `$ ${mcpCommand(server)}`
}

function displayMcpUrl(server: McpServerDefinition): string {
  if (!server.url) return ''
  const url = new URL(server.url ?? '')
  if (url.search) url.search = '?…'
  return url.href
}

function redactMcpSecrets(text: string, server: McpServerDefinition): string {
  if (server.transport !== 'http') return text
  const url = new URL(server.url ?? '')
  const secrets = [...Object.values(server.headers), ...[...url.searchParams.values()]]
    .filter((value) => value.length >= 4)
    .sort((left, right) => right.length - left.length)
  let safe = text
  for (const secret of secrets) safe = safe.split(secret).join('[nilai MCP disembunyikan]')
  return safe
}

export const listMcpServersTool: Tool<Record<string, never>> = {
  name: 'list_mcp_servers', description: 'List configured MCP stdio and Streamable HTTP servers without connecting to them.', risk: 'safe',
  schema: { type: 'function', function: { name: 'list_mcp_servers', description: 'List configured MCP servers without executing them.', parameters: { type: 'object', properties: {} } } },
  preview: () => 'lihat MCP server',
  async run(_args, context) {
    const servers = loadMcpServers(context.workspace, context.home)
    return { content: servers.length ? servers.map((server) => `${server.name} [${server.source}/${server.transport}] — ${serverSummary(server)}`).join('\n') : 'Tidak ada MCP server yang dikonfigurasi.' }
  },
}

interface ServerArgs { server: string; timeout?: number }

export const mcpListToolsTool: Tool<ServerArgs> = {
  name: 'mcp_list_tools', description: 'Connect to one configured MCP server and list its available tools. Requires approval.', risk: 'confirm', runsCommand: true,
  schema: { type: 'function', function: { name: 'mcp_list_tools', description: 'Discover tools exposed by one configured MCP server.', parameters: { type: 'object', properties: { server: { type: 'string' }, timeout: { type: 'number' } }, required: ['server'] } } },
  preview: (args) => `lihat tools MCP ${args.server}`,
  async detail(args, context) {
    try { const server = serverNamed(args.server, context.workspace, context.home); return [{ kind: 'context', text: serverDetail(server) }] } catch { return null }
  },
  async run(args, context) {
    try {
      const server = serverNamed(args.server, context.workspace, context.home)
      const result = await withMcp(context.workspace, server, context.sandbox, context.signal, timeout(args.timeout), (connection) => connection.request('tools/list', {}, timeout(args.timeout), context.signal))
      const tools = (result as { tools?: unknown } | null)?.tools
      const content = transportWarning(server, context.workspace, context.sandbox) + (Array.isArray(tools) ? JSON.stringify(tools, null, 2) : 'MCP server tidak mengembalikan daftar tools.')
      return { content: redactMcpSecrets(content, server) }
    } catch (error) {
      let message = error instanceof Error ? error.message : 'discovery MCP gagal'
      try { message = redactMcpSecrets(message, serverNamed(args.server, context.workspace, context.home)) } catch { /* server tidak valid */ }
      return { content: `Gagal: ${message}`, isError: true }
    }
  },
}

interface CallArgs extends ServerArgs { tool: string; arguments?: Record<string, unknown> }

export const mcpCallTool: Tool<CallArgs> = {
  name: 'mcp_call', description: 'Call one tool on a configured MCP server. Every call requires fresh approval because MCP tools may have external side effects.', risk: 'confirm', allowAlways: false, runsCommand: true,
  schema: {
    type: 'function',
    function: {
      name: 'mcp_call', description: 'Invoke a discovered MCP tool after fresh user approval.',
      parameters: {
        type: 'object',
        properties: { server: { type: 'string' }, tool: { type: 'string' }, arguments: { type: 'object', additionalProperties: true }, timeout: { type: 'number' } },
        required: ['server', 'tool'],
      },
    },
  },
  preview: (args) => `panggil MCP ${args.server}/${args.tool}`,
  async detail(args, context) {
    try { const server = serverNamed(args.server, context.workspace, context.home); return [{ kind: 'context', text: `${serverDetail(server)}\ntool: ${args.tool}\narguments: ${JSON.stringify(args.arguments ?? {})}` }] } catch { return null }
  },
  async run(args, context) {
    try {
      const server = serverNamed(args.server, context.workspace, context.home)
      const result = await withMcp(context.workspace, server, context.sandbox, context.signal, timeout(args.timeout), (connection) => connection.request('tools/call', { name: args.tool, arguments: args.arguments ?? {} }, timeout(args.timeout), context.signal))
      const formatted = formatMcpResult(result)
      const content = redactMcpSecrets(transportWarning(server, context.workspace, context.sandbox) + formatted.content, server)
      return { content, ...(formatted.isError ? { isError: true } : {}) }
    } catch (error) {
      let message = error instanceof Error ? error.message : 'pemanggilan MCP gagal'
      try { message = redactMcpSecrets(message, serverNamed(args.server, context.workspace, context.home)) } catch { /* server tidak valid */ }
      return { content: `Gagal: ${message}`, isError: true }
    }
  },
}
