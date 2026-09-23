import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { extname, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { ChildProcess } from 'node:child_process'
import type { Tool } from '../domain/tool.ts'
import type { SandboxPolicy } from './sandbox.ts'
import { isProtectedWorkspacePath } from './sandbox.ts'
import { isSensitivePath, sensitiveRefusal } from './secrets.ts'
import { OutputBuffer, startCommand, terminate } from './shell.ts'
import { resolveInWorkspace } from './workspace.ts'

export type LspAction = 'document_symbols' | 'definition' | 'references' | 'hover' | 'diagnostics'
export interface LspServerDefinition { label: string; languageId: string; command: string; installHint: string }
export interface LspQuery { path: string; action: LspAction; line?: number; column?: number; timeout?: number }

interface RpcMessage {
  jsonrpc: '2.0'
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
}

interface Pending {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: NodeJS.Timeout
  cleanup(): void
}

export const LSP_SESSION_IDLE_MS = 5 * 60_000
export const MAX_LSP_SESSIONS = 4
export const MAX_LSP_OPEN_DOCUMENTS = 40

export interface LspSessionMetric {
  reused: boolean
  restarted: boolean
  openDocuments: number
}

export interface LspQueryResult {
  content: string
  hasErrors?: boolean
  session: LspSessionMetric
}

function quote(value: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return `"${value.replace(/"/g, '""')}"`
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

function localBinary(workspace: string, unix: string, windows = `${unix}.cmd`): string | null {
  const path = resolve(workspace, 'node_modules', '.bin', process.platform === 'win32' ? windows : unix)
  return existsSync(path) ? path : null
}

/** Memilih language server yang lazim, mengutamakan dependency lokal proyek. */
export function languageServerFor(workspace: string, path: string): LspServerDefinition | null {
  const extension = extname(path).toLowerCase()
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts', '.cjs', '.cts'].includes(extension)) {
    const local = localBinary(workspace, 'typescript-language-server')
    return {
      label: 'TypeScript Language Server', languageId: ['.ts', '.mts', '.cts'].includes(extension) ? 'typescript' : extension === '.tsx' ? 'typescriptreact' : extension === '.jsx' ? 'javascriptreact' : 'javascript',
      command: `${local ? quote(local) : 'typescript-language-server'} --stdio`,
      installHint: 'Pasang typescript-language-server dan typescript di proyek (misalnya: pnpm add -D typescript-language-server typescript).',
    }
  }
  if (extension === '.py') {
    const local = localBinary(workspace, 'pyright-langserver')
      ?? [resolve(workspace, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'pyright-langserver.exe' : 'pyright-langserver')].find(existsSync)
    return { label: 'Pyright', languageId: 'python', command: `${local ? quote(local) : 'pyright-langserver'} --stdio`, installHint: 'Pasang Pyright secara lokal atau sediakan pyright-langserver di PATH.' }
  }
  if (extension === '.go') return { label: 'gopls', languageId: 'go', command: 'gopls', installHint: 'Pasang gopls dan pastikan tersedia di PATH.' }
  if (extension === '.rs') return { label: 'rust-analyzer', languageId: 'rust', command: 'rust-analyzer', installHint: 'Pasang rust-analyzer dan pastikan tersedia di PATH.' }
  if (['.c', '.h', '.cc', '.cpp', '.cxx', '.hpp'].includes(extension)) return { label: 'clangd', languageId: ['.c', '.h'].includes(extension) ? 'c' : 'cpp', command: 'clangd --background-index=false', installHint: 'Pasang clangd dan pastikan tersedia di PATH.' }
  if (extension === '.dart') return { label: 'Dart Analysis Server', languageId: 'dart', command: 'dart language-server --protocol=lsp', installHint: 'Pasang Dart SDK dan pastikan perintah dart tersedia di PATH.' }
  return null
}

class LspConnection {
  private readonly child: ChildProcess
  private readonly pending = new Map<number, Pending>()
  private readonly notifications = new Set<(message: RpcMessage) => void>()
  private readonly stderr = new OutputBuffer(2_000, 6_000)
  private buffer = Buffer.alloc(0)
  private nextId = 1
  private ended = false

  constructor(command: string, workspace: string, sandbox?: SandboxPolicy) {
    this.child = startCommand(command, { cwd: workspace, sandbox, stdin: 'pipe' })
    this.child.unref()
    ;(this.child.stdin as { unref?: () => void } | null)?.unref?.()
    ;(this.child.stdout as { unref?: () => void } | null)?.unref?.()
    ;(this.child.stderr as { unref?: () => void } | null)?.unref?.()
    this.child.stdout?.on('data', (chunk: Buffer | string) => this.consume(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    this.child.stderr?.on('data', (chunk: Buffer | string) => this.stderr.append(chunk.toString()))
    this.child.once('error', (error) => {
      this.ended = true
      this.failAll(new Error(`Language server gagal dimulai: ${error.message}`, { cause: error }))
    })
    this.child.once('close', (code) => {
      const expected = this.ended
      this.ended = true
      if (!expected) this.failAll(new Error(`Language server berhenti (exit ${code ?? '?'}). ${this.stderr.toString()}`.trim()))
    })
  }

  private consume(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n')
      if (headerEnd === -1) return
      const header = this.buffer.subarray(0, headerEnd).toString('ascii')
      const length = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(header)?.[1]
      if (!length) { this.failAll(new Error('Respons LSP tidak memiliki Content-Length.')); return }
      const bytes = Number(length)
      const bodyStart = headerEnd + 4
      if (this.buffer.length < bodyStart + bytes) return
      const body = this.buffer.subarray(bodyStart, bodyStart + bytes).toString('utf8')
      this.buffer = this.buffer.subarray(bodyStart + bytes)
      try { this.handle(JSON.parse(body) as RpcMessage) } catch (error) {
        this.failAll(new Error('Respons JSON dari language server tidak valid.', { cause: error }))
      }
    }
  }

  private handle(message: RpcMessage): void {
    if (message.method && message.id !== undefined) {
      let result: unknown = null
      if (message.method === 'workspace/configuration') {
        const items = (message.params as { items?: unknown[] } | undefined)?.items ?? []
        result = items.map(() => null)
      } else if (message.method === 'workspace/workspaceFolders') result = null
      else if (message.method === 'workspace/applyEdit') result = { applied: false, failureReason: 'Boo menjalankan LSP dalam mode baca.' }
      this.send({ jsonrpc: '2.0', id: message.id, result })
      return
    }
    if (message.method) {
      for (const listener of this.notifications) listener(message)
      return
    }
    if (typeof message.id !== 'number') return
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    clearTimeout(pending.timer)
    pending.cleanup()
    if (message.error) pending.reject(new Error(`LSP ${message.error.code ?? ''}: ${message.error.message ?? 'request gagal'}`.trim()))
    else pending.resolve(message.result)
  }

  private send(message: RpcMessage): void {
    if (!this.child.stdin?.writable) throw new Error('stdin language server tidak tersedia.')
    const body = JSON.stringify(message)
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
  }

  notify(method: string, params: unknown): void { this.send({ jsonrpc: '2.0', method, params }) }

  request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(new Error('Permintaan LSP dibatalkan.'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const item = this.pending.get(id)
        if (!item) return
        this.pending.delete(id)
        clearTimeout(item.timer)
        item.cleanup()
        reject(new Error('Permintaan LSP dibatalkan.'))
      }
      const timer = setTimeout(() => {
        this.pending.delete(id)
        signal?.removeEventListener('abort', onAbort)
        reject(new Error(`Language server tidak menjawab ${method} dalam ${Math.ceil(timeoutMs / 1_000)} detik.`))
      }, timeoutMs)
      const cleanup = () => signal?.removeEventListener('abort', onAbort)
      this.pending.set(id, { resolve, reject, timer, cleanup })
      signal?.addEventListener('abort', onAbort, { once: true })
      try { this.send({ jsonrpc: '2.0', id, method, params }) } catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        cleanup()
        reject(error as Error)
      }
    })
  }

  onNotification(listener: (message: RpcMessage) => void): () => void {
    this.notifications.add(listener)
    return () => this.notifications.delete(listener)
  }

  get alive(): boolean { return !this.ended }

  private failAll(error: Error): void {
    for (const item of this.pending.values()) {
      clearTimeout(item.timer)
      item.cleanup()
      item.reject(error)
    }
    this.pending.clear()
  }

  async close(timeoutMs = 2_000): Promise<void> {
    if (this.ended) return
    try { await this.request('shutdown', null, timeoutMs) } catch { /* server sudah berhenti */ }
    try { this.notify('exit', null) } catch { /* stdin sudah tertutup */ }
    this.ended = true
    this.child.stdin?.end()
    terminate(this.child, 500)
  }
}

interface OpenDocument { hash: string; version: number; touchedAt: number }

class PersistentLspSession {
  readonly connection: LspConnection
  readonly documents = new Map<string, OpenDocument>()
  lastUsedAt = Date.now()
  private queue: Promise<unknown> = Promise.resolve()

  private constructor(connection: LspConnection) {
    this.connection = connection
  }

  static async create(workspace: string, server: LspServerDefinition, sandbox: SandboxPolicy | undefined, timeoutMs: number, signal?: AbortSignal): Promise<PersistentLspSession> {
    const connection = new LspConnection(server.command, workspace, sandbox)
    const session = new PersistentLspSession(connection)
    const rootUri = pathToFileURL(resolve(workspace)).href
    try {
      await connection.request('initialize', {
        processId: process.pid,
        clientInfo: { name: 'Boo Code', version: '0.1.0' },
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: resolve(workspace).split(sep).at(-1) || 'workspace' }],
        capabilities: {
          workspace: { workspaceFolders: true, configuration: true },
          textDocument: { synchronization: { didSave: true }, documentSymbol: {}, definition: {}, references: {}, hover: {}, diagnostic: {} },
        },
      }, timeoutMs, signal)
      connection.notify('initialized', {})
      return session
    } catch (error) {
      await connection.close()
      throw error
    }
  }

  get alive(): boolean { return this.connection.alive }

  runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation)
    this.queue = next.then(() => undefined, () => undefined)
    return next
  }

  syncDocument(uri: string, languageId: string, content: string): void {
    const hash = createHash('sha256').update(content).digest('hex')
    const current = this.documents.get(uri)
    this.lastUsedAt = Date.now()
    if (!current) {
      this.connection.notify('textDocument/didOpen', { textDocument: { uri, languageId, version: 1, text: content } })
      this.documents.set(uri, { hash, version: 1, touchedAt: this.lastUsedAt })
    } else if (current.hash !== hash) {
      current.hash = hash
      current.version += 1
      current.touchedAt = this.lastUsedAt
      this.connection.notify('textDocument/didChange', { textDocument: { uri, version: current.version }, contentChanges: [{ text: content }] })
    } else current.touchedAt = this.lastUsedAt
    this.evictDocuments(uri)
  }

  private evictDocuments(activeUri: string): void {
    if (this.documents.size <= MAX_LSP_OPEN_DOCUMENTS) return
    const oldest = [...this.documents.entries()]
      .filter(([uri]) => uri !== activeUri)
      .sort((a, b) => a[1].touchedAt - b[1].touchedAt)
      .slice(0, this.documents.size - MAX_LSP_OPEN_DOCUMENTS)
    for (const [uri] of oldest) {
      try { this.connection.notify('textDocument/didClose', { textDocument: { uri } }) } catch { /* session akan dipulihkan pada query berikutnya */ }
      this.documents.delete(uri)
    }
  }

  async close(): Promise<void> { await this.connection.close() }
}

interface PoolEntry { key: string; session: PersistentLspSession; idle?: NodeJS.Timeout }

class LspSessionPool {
  private readonly entries = new Map<string, PoolEntry>()
  private readonly creating = new Map<string, Promise<PersistentLspSession>>()

  private key(workspace: string, server: LspServerDefinition, sandbox?: SandboxPolicy): string {
    return `${resolve(workspace)}\0${server.command}\0${sandbox?.mode ?? 'workspace-write'}\0${Boolean(sandbox?.networkAccess)}`
  }

  async acquire(workspace: string, server: LspServerDefinition, sandbox: SandboxPolicy | undefined, timeoutMs: number, signal?: AbortSignal): Promise<{ entry: PoolEntry; reused: boolean }> {
    const key = this.key(workspace, server, sandbox)
    const existing = this.entries.get(key)
    if (existing?.session.alive) {
      this.touch(existing)
      return { entry: existing, reused: true }
    }
    if (existing) await this.remove(key)
    let pending = this.creating.get(key)
    const reusedCreation = Boolean(pending)
    if (!pending) {
      pending = PersistentLspSession.create(workspace, server, sandbox, timeoutMs, signal)
      this.creating.set(key, pending)
    }
    try {
      const session = await pending
      let entry = this.entries.get(key)
      if (!entry) {
        entry = { key, session }
        this.entries.set(key, entry)
        this.touch(entry)
        await this.enforceLimit(key)
      }
      return { entry, reused: reusedCreation }
    } finally {
      if (this.creating.get(key) === pending) this.creating.delete(key)
    }
  }

  touch(entry: PoolEntry): void {
    entry.session.lastUsedAt = Date.now()
    if (entry.idle) clearTimeout(entry.idle)
    entry.idle = setTimeout(() => { void this.remove(entry.key) }, LSP_SESSION_IDLE_MS)
    entry.idle.unref?.()
  }

  async invalidate(entry: PoolEntry): Promise<void> {
    if (this.entries.get(entry.key) === entry) await this.remove(entry.key)
  }

  private async enforceLimit(activeKey: string): Promise<void> {
    if (this.entries.size <= MAX_LSP_SESSIONS) return
    const oldest = [...this.entries.values()]
      .filter((entry) => entry.key !== activeKey)
      .sort((a, b) => a.session.lastUsedAt - b.session.lastUsedAt)[0]
    if (oldest) await this.remove(oldest.key)
  }

  private async remove(key: string): Promise<void> {
    const entry = this.entries.get(key)
    if (!entry) return
    this.entries.delete(key)
    if (entry.idle) clearTimeout(entry.idle)
    await entry.session.close()
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((key) => this.remove(key)))
  }

  snapshot(): { sessions: number; openDocuments: number } {
    return { sessions: this.entries.size, openDocuments: [...this.entries.values()].reduce((sum, entry) => sum + entry.session.documents.size, 0) }
  }
}

const lspSessions = new LspSessionPool()

/** Test/host lifecycle hook; normal CLI sessions are reclaimed by idle timeout. */
export async function closeLspSessions(): Promise<void> { await lspSessions.closeAll() }
export function lspSessionSnapshot(): { sessions: number; openDocuments: number } { return lspSessions.snapshot() }

const SYMBOL_KIND: Record<number, string> = {
  2: 'module', 3: 'namespace', 5: 'class', 6: 'method', 7: 'property', 8: 'field', 9: 'constructor',
  10: 'enum', 11: 'interface', 12: 'function', 13: 'variable', 14: 'constant', 22: 'enum-member',
  23: 'struct', 25: 'operator', 26: 'type-parameter',
}

function position(line?: number, column?: number): { line: number; character: number } {
  if (!Number.isInteger(line) || !Number.isInteger(column) || line! < 1 || column! < 1) {
    throw new Error('Action ini membutuhkan line dan column berupa angka 1-based.')
  }
  return { line: line! - 1, character: column! - 1 }
}

function locationLine(workspace: string, value: unknown): string | null {
  const item = value as { uri?: string; targetUri?: string; range?: { start?: { line?: number; character?: number } }; targetSelectionRange?: { start?: { line?: number; character?: number } } }
  const uri = item.uri ?? item.targetUri
  if (!uri?.startsWith('file:')) return null
  let absolute: string
  try { absolute = fileURLToPath(uri) } catch { return null }
  const path = relative(resolve(workspace), absolute)
  if (path.startsWith('..') || path.startsWith(sep)) return null
  const start = item.range?.start ?? item.targetSelectionRange?.start
  return `${path.split(sep).join('/')}:${(start?.line ?? 0) + 1}:${(start?.character ?? 0) + 1}`
}

function formatLocations(workspace: string, result: unknown): string {
  const values = result ? (Array.isArray(result) ? result : [result]) : []
  const lines = values.map((value) => locationLine(workspace, value)).filter((value): value is string => Boolean(value))
  return lines.length ? [...new Set(lines)].slice(0, 200).join('\n') : '(tidak ditemukan)'
}

interface LspSymbol { name?: string; kind?: number; location?: { uri?: string; range?: { start?: { line?: number } } }; range?: { start?: { line?: number } }; children?: LspSymbol[] }

function formatSymbols(result: unknown): string {
  const lines: string[] = []
  const visit = (symbols: LspSymbol[], depth = 0) => {
    for (const symbol of symbols) {
      const line = symbol.range?.start?.line ?? symbol.location?.range?.start?.line ?? 0
      lines.push(`${'  '.repeat(depth)}${line + 1}: ${SYMBOL_KIND[symbol.kind ?? 0] ?? 'symbol'} ${symbol.name ?? '(tanpa nama)'}`)
      if (symbol.children?.length) visit(symbol.children, depth + 1)
      if (lines.length >= 300) return
    }
  }
  visit(Array.isArray(result) ? result as LspSymbol[] : [])
  return lines.length ? lines.join('\n') : '(tidak ada simbol)'
}

function markup(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(markup).filter(Boolean).join('\n\n')
  if (!value || typeof value !== 'object') return ''
  const object = value as { value?: unknown; language?: string; contents?: unknown }
  if (object.contents !== undefined) return markup(object.contents)
  if (typeof object.value === 'string') return object.language ? `\`\`\`${object.language}\n${object.value}\n\`\`\`` : object.value
  return ''
}

interface Diagnostic { range?: { start?: { line?: number; character?: number } }; severity?: number; code?: unknown; source?: string; message?: string }
const SEVERITY: Record<number, string> = { 1: 'error', 2: 'warning', 3: 'info', 4: 'hint' }

function formatDiagnostics(path: string, diagnostics: Diagnostic[]): { text: string; errors: number } {
  let errors = 0
  const lines = diagnostics.slice(0, 300).map((diagnostic) => {
    if (diagnostic.severity === 1) errors += 1
    const start = diagnostic.range?.start
    const severity = SEVERITY[diagnostic.severity ?? 0] ?? 'diagnostic'
    const code = diagnostic.code === undefined ? '' : ` ${String(diagnostic.code)}`
    const source = diagnostic.source ? ` [${diagnostic.source}]` : ''
    return `${path}:${(start?.line ?? 0) + 1}:${(start?.character ?? 0) + 1}: ${severity}${code}${source}: ${(diagnostic.message ?? '').replace(/\s+/g, ' ').trim()}`
  })
  return { text: lines.length ? lines.join('\n') : 'Tidak ada diagnostics untuk file ini.', errors }
}

function pullDiagnostics(result: unknown): Diagnostic[] | null {
  if (!result || typeof result !== 'object') return null
  const items = (result as { items?: unknown }).items
  return Array.isArray(items) ? items as Diagnostic[] : null
}

export async function runLspQuery(
  workspace: string,
  query: LspQuery,
  options: { server?: LspServerDefinition; sandbox?: SandboxPolicy; signal?: AbortSignal; persistent?: boolean } = {},
): Promise<LspQueryResult> {
  if (!new Set<LspAction>(['document_symbols', 'definition', 'references', 'hover', 'diagnostics']).has(query.action)) {
    throw new Error(`Action LSP tidak dikenal: ${String(query.action)}`)
  }
  const target = resolveInWorkspace(workspace, query.path)
  const server = options.server ?? languageServerFor(workspace, query.path)
  if (!server) throw new Error(`Belum ada adapter language server untuk ${extname(query.path) || 'tipe file ini'}.`)
  const timeoutMs = Math.max(3, Math.min(120, Number.isFinite(query.timeout) ? Math.round(query.timeout!) : 30)) * 1_000
  if (query.action === 'definition' || query.action === 'references' || query.action === 'hover') position(query.line, query.column)
  const content = await readFile(target, 'utf8')
  const uri = pathToFileURL(target).href
  const execute = async (session: PersistentLspSession, metric: LspSessionMetric): Promise<LspQueryResult> => session.runExclusive(async () => {
    const connection = session.connection
    let published: Diagnostic[] | null = null
    const stopListening = connection.onNotification((message) => {
      if (message.method !== 'textDocument/publishDiagnostics') return
      const params = message.params as { uri?: string; diagnostics?: unknown } | undefined
      if (params?.uri === uri && Array.isArray(params.diagnostics)) published = params.diagnostics as Diagnostic[]
    })
    try {
      session.syncDocument(uri, server.languageId, content)
      metric.openDocuments = session.documents.size
      if (query.action === 'document_symbols') {
        const result = await connection.request('textDocument/documentSymbol', { textDocument: { uri } }, timeoutMs, options.signal)
        return { content: formatSymbols(result), session: metric }
      }
      if (query.action === 'hover') {
        const result = await connection.request('textDocument/hover', { textDocument: { uri }, position: position(query.line, query.column) }, timeoutMs, options.signal)
        const output = markup(result).trim()
        return { content: output ? output.slice(0, 60_000) : '(tidak ada hover)', session: metric }
      }
      if (query.action === 'definition' || query.action === 'references') {
        const params = { textDocument: { uri }, position: position(query.line, query.column) }
        const result = query.action === 'definition'
          ? await connection.request('textDocument/definition', params, timeoutMs, options.signal)
          : await connection.request('textDocument/references', { ...params, context: { includeDeclaration: true } }, timeoutMs, options.signal)
        return { content: formatLocations(workspace, result), session: metric }
      }

      let diagnostics: Diagnostic[] | null = null
      try {
        diagnostics = pullDiagnostics(await connection.request('textDocument/diagnostic', { textDocument: { uri } }, Math.min(timeoutMs, 8_000), options.signal))
      } catch {
        // Banyak server masih memakai push diagnostics; tunggu notifikasinya.
      }
      if (!diagnostics && !published) await new Promise<void>((resolveWait) => setTimeout(resolveWait, Math.min(2_000, timeoutMs)))
      const formatted = formatDiagnostics(query.path, diagnostics ?? published ?? [])
      return { content: formatted.text, hasErrors: formatted.errors > 0, session: metric }
    } finally {
      stopListening()
    }
  })

  if (options.persistent === false) {
    const session = await PersistentLspSession.create(workspace, server, options.sandbox, timeoutMs, options.signal)
    try { return await execute(session, { reused: false, restarted: false, openDocuments: 0 }) } finally { await session.close() }
  }

  let restarted = false
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let acquired: { entry: PoolEntry; reused: boolean } | undefined
    try {
      acquired = await lspSessions.acquire(workspace, server, options.sandbox, timeoutMs, options.signal)
      const result = await execute(acquired.entry.session, { reused: acquired.reused, restarted, openDocuments: 0 })
      lspSessions.touch(acquired.entry)
      return result
    } catch (error) {
      if (acquired) await lspSessions.invalidate(acquired.entry)
      if (attempt === 0 && !options.signal?.aborted) { restarted = true; continue }
      const detail = error instanceof Error ? error.message : 'request LSP gagal'
      throw new Error(`${server.label}: ${detail} ${server.installHint}`, { cause: error })
    }
  }
  throw new Error(`${server.label}: session LSP tidak dapat dipulihkan. ${server.installHint}`)
}

export const lspTool: Tool<LspQuery> = {
  name: 'lsp',
  description: 'Query an installed Language Server for precise document symbols, go-to-definition, references, hover, or per-file diagnostics. The sandboxed server session is reused briefly within this Boo process; it never installs one.',
  risk: 'confirm',
  runsCommand: true,
  schema: {
    type: 'function',
    function: {
      name: 'lsp',
      description: 'Use semantic language intelligence from a locally installed LSP server.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Source file relative to the workspace root' },
          action: { type: 'string', enum: ['document_symbols', 'definition', 'references', 'hover', 'diagnostics'] },
          line: { type: 'number', description: '1-based line; required for definition, references, and hover' },
          column: { type: 'number', description: '1-based UTF-16 column; required for definition, references, and hover' },
          timeout: { type: 'number', description: 'Timeout in seconds, 3–120; defaults to 30' },
        },
        required: ['path', 'action'],
      },
    },
  },
  preview: (args) => `${args.action} ${args.path}${args.line ? `:${args.line}:${args.column ?? 1}` : ''}`,
  async detail(args, context) {
    const server = languageServerFor(context.workspace, args.path)
    return server ? [{ kind: 'context', text: `${server.label}: $ ${server.command}` }] : null
  },
  async run(args, context) {
    if (isProtectedWorkspacePath(args.path)) return { content: `Ditolak: ${args.path} adalah path agent yang dilindungi.`, isError: true }
    if (isSensitivePath(args.path)) return { content: sensitiveRefusal(args.path), isError: true }
    try {
      const result = await runLspQuery(context.workspace, args, { sandbox: context.sandbox, signal: context.signal })
      return { content: result.content, ...(result.hasErrors ? { isError: true } : {}), lspSession: result.session }
    } catch (error) {
      return { content: `Gagal: ${error instanceof Error ? error.message : 'LSP gagal'}`, isError: true }
    }
  },
}
