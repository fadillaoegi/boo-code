/** Indeks repository filesystem-first: simbol, dependency, dan identifier—tanpa source penuh. */

import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, posix, relative, resolve, sep } from 'node:path'
import type { Tool } from '../domain/tool.ts'
import type { FileSnapshots } from './fileSnapshots.ts'
import { analyzeRepositorySource, type RepositoryCall, type RepositorySymbol } from './repoMap.ts'
import { findFiles } from './search.ts'
import { isSensitivePath } from './secrets.ts'
import { resolveInWorkspace } from './workspace.ts'

const INDEX_VERSION = 2
const INDEX_DIRECTORY = 'indexes'
const MAX_FILES = 5_000
const MAX_FILE_BYTES = 512_000
const MAX_INDEX_BYTES = 30_000_000
const MAX_IDENTIFIERS = 160
const MAX_IDENTIFIER_LINES = 5
const MAX_RESULTS = 30
const SOURCE_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.cs', '.dart', '.ex', '.exs', '.go', '.h', '.hpp', '.java', '.js', '.jsx',
  '.kt', '.kts', '.mjs', '.mts', '.php', '.py', '.rb', '.rs', '.scala', '.swift', '.svelte', '.ts',
  '.tsx', '.vue',
])
const IMPORTANT_FILES = new Set([
  'package.json', 'pyproject.toml', 'go.mod', 'cargo.toml', 'pubspec.yaml', 'pom.xml', 'build.gradle',
  'build.gradle.kts', 'composer.json', 'gemfile', 'makefile', 'cmakelists.txt',
])
const STOP_WORDS = new Set([
  'const', 'let', 'var', 'function', 'class', 'interface', 'type', 'return', 'import', 'export', 'from',
  'default', 'async', 'await', 'public', 'private', 'protected', 'static', 'final', 'true', 'false', 'null',
  'undefined', 'self', 'this', 'super', 'string', 'number', 'boolean', 'object', 'void', 'any', 'unknown',
  'if', 'else', 'for', 'while', 'switch', 'case', 'break', 'continue', 'new', 'throw', 'throws', 'try',
  'catch', 'finally', 'with', 'def', 'fn', 'func', 'struct', 'enum', 'impl', 'trait', 'package', 'module',
  'the', 'and', 'or', 'not', 'in', 'of', 'to', 'as', 'is', 'it', 'that', 'use', 'using', 'include',
])
const SYNONYMS: Record<string, string[]> = {
  auth: ['authentication', 'authorize', 'authorization', 'login', 'signin', 'session'],
  login: ['auth', 'authentication', 'signin', 'session'],
  user: ['account', 'profile', 'member'],
  error: ['failure', 'exception', 'fault'],
  bug: ['error', 'failure', 'regression', 'issue'],
  config: ['configuration', 'settings', 'options'],
  database: ['db', 'repository', 'storage', 'persistence'],
  api: ['endpoint', 'route', 'controller', 'handler'],
  test: ['tests', 'spec', 'fixture', 'mock'],
  cache: ['memo', 'cached', 'caching'],
  keamanan: ['security', 'auth', 'permission'],
  pengguna: ['user', 'account', 'profile'],
}

interface IndexedIdentifier { token: string; count: number; lines: number[] }
export interface IndexedRepositoryFile {
  path: string
  size: number
  modifiedAt: number
  hash: string
  symbols: RepositorySymbol[]
  imports: string[]
  calls: RepositoryCall[]
  inherits: string[]
  parser: 'typescript-ast' | 'fallback'
  identifiers: IndexedIdentifier[]
}
export interface RepositoryIndex {
  version: 2
  workspaceId: string
  builtAt: number
  files: IndexedRepositoryFile[]
}
export interface RepositoryIndexUpdate {
  index: RepositoryIndex
  scanned: number
  reused: number
  updated: number
  removed: number
  persisted: boolean
}

const memoryIndexes = new Map<string, RepositoryIndex>()

function idFor(workspace: string): string {
  return createHash('sha256').update(resolve(workspace)).digest('hex').slice(0, 24)
}

function inside(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
}

function indexPath(home: string, workspaceId: string): string {
  return join(home, '.boo', INDEX_DIRECTORY, workspaceId, `repository-v${INDEX_VERSION}.json`)
}

function words(value: string): string[] {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9_$]+/).filter((word) => word.length > 1)
}

function queryWords(value: string): string[] {
  const initial = words(value).filter((word) => !STOP_WORDS.has(word))
  const expanded = new Set(initial)
  for (const word of initial) for (const synonym of SYNONYMS[word] ?? []) expanded.add(synonym)
  return [...expanded].slice(0, 30)
}

/** Menghapus komentar dan literal sambil mempertahankan nomor baris. */
function codeShape(content: string): string {
  let output = ''
  let index = 0
  let state: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' | 'triple-single' | 'triple-double' = 'code'
  while (index < content.length) {
    const char = content[index]
    const next = content[index + 1]
    const triple = content.slice(index, index + 3)
    if (state === 'code') {
      if (char === '/' && next === '/') { state = 'line'; output += '  '; index += 2; continue }
      if (char === '/' && next === '*') { state = 'block'; output += '  '; index += 2; continue }
      if (char === '#') { state = 'line'; output += ' '; index += 1; continue }
      if (triple === "'''") { state = 'triple-single'; output += '   '; index += 3; continue }
      if (triple === '"""') { state = 'triple-double'; output += '   '; index += 3; continue }
      if (char === "'") state = 'single'
      else if (char === '"') state = 'double'
      else if (char === '`') state = 'template'
      output += state === 'code' ? char : ' '
      index += 1
      continue
    }
    if (char === '\n') {
      output += '\n'
      if (state === 'line' || state === 'single' || state === 'double') state = 'code'
      index += 1
      continue
    }
    if (state === 'line') { output += ' '; index += 1; continue }
    if (state === 'block' && char === '*' && next === '/') { output += '  '; index += 2; state = 'code'; continue }
    if (state === 'triple-single' && triple === "'''") { output += '   '; index += 3; state = 'code'; continue }
    if (state === 'triple-double' && triple === '"""') { output += '   '; index += 3; state = 'code'; continue }
    if ((state === 'single' && char === "'") || (state === 'double' && char === '"') || (state === 'template' && char === '`')) {
      output += ' '; index += 1; state = 'code'; continue
    }
    if ((state === 'single' || state === 'double' || state === 'template') && char === '\\' && next !== undefined) {
      output += '  '; index += 2; continue
    }
    output += ' '
    index += 1
  }
  return output
}

function identifiers(content: string): IndexedIdentifier[] {
  const byToken = new Map<string, { count: number; lines: number[] }>()
  for (const [lineIndex, line] of codeShape(content).split('\n').entries()) {
    for (const token of words(line)) {
      if (token.length < 3 || token.length > 64 || STOP_WORDS.has(token) || /^\d+$/.test(token)) continue
      const item = byToken.get(token) ?? { count: 0, lines: [] }
      item.count += 1
      if (item.lines.length < MAX_IDENTIFIER_LINES && item.lines.at(-1) !== lineIndex + 1) item.lines.push(lineIndex + 1)
      byToken.set(token, item)
    }
  }
  return [...byToken.entries()].sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0])).slice(0, MAX_IDENTIFIERS)
    .map(([token, value]) => ({ token, ...value }))
}

function fallbackImports(content: string, extension: string): string[] {
  const found = new Set<string>()
  if (extension === '.go') {
    for (const match of content.matchAll(/^\s*import\s+"([^"]+)"/gm)) if (match[1]?.length <= 200) found.add(match[1])
    for (const block of content.matchAll(/\bimport\s*\(([\s\S]*?)\)/g)) {
      for (const match of block[1].matchAll(/"([^"]+)"/g)) if (match[1]?.length <= 200) found.add(match[1])
    }
    return [...found].slice(0, 80)
  }
  const patterns = extension === '.py'
    ? [/^\s*from\s+([\w.]+)\s+import/gm, /^\s*import\s+([\w.]+)/gm]
    : extension === '.rs'
      ? [/^\s*(?:pub\s+)?(?:use|mod)\s+([\w:]+)/gm]
      : ['.java', '.kt', '.kts', '.scala'].includes(extension)
        ? [/^\s*import\s+([\w.*]+)/gm]
        : [/\bfrom\s+['"]([^'"]+)['"]/g, /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g, /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, /^\s*import\s+['"]([^'"]+)['"]/gm]
  for (const pattern of patterns) for (const match of content.matchAll(pattern)) if (match[1]?.length <= 200) found.add(match[1])
  return [...found].slice(0, 80)
}

function indexable(path: string): boolean {
  return SOURCE_EXTENSIONS.has(extname(path).toLowerCase()) || IMPORTANT_FILES.has(basename(path).toLowerCase())
}

async function loadIndex(home: string | undefined, workspaceId: string): Promise<RepositoryIndex | null> {
  const memory = memoryIndexes.get(workspaceId)
  if (memory) return memory
  if (!home) return null
  const path = indexPath(home, workspaceId)
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size > MAX_INDEX_BYTES) return null
    const parsed = JSON.parse(await readFile(path, 'utf8')) as RepositoryIndex
    if (parsed.version !== INDEX_VERSION || parsed.workspaceId !== workspaceId || !Array.isArray(parsed.files)) return null
    memoryIndexes.set(workspaceId, parsed)
    return parsed
  } catch { return null }
}

async function persistIndex(home: string | undefined, index: RepositoryIndex): Promise<boolean> {
  memoryIndexes.set(index.workspaceId, index)
  if (!home) return false
  const serialized = `${JSON.stringify(index)}\n`
  // Repository yang sangat besar tetap dapat dicari pada proses aktif, tetapi
  // metadata yang melewati batas tidak ditulis ke disk tanpa kendali.
  if (Buffer.byteLength(serialized) > MAX_INDEX_BYTES) return false
  const target = indexPath(home, index.workspaceId)
  const directory = dirname(target)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, serialized, { mode: 0o600, flag: 'wx' })
  await rename(temporary, target)
  return true
}

export async function updateRepositoryIndex(workspace: string, home?: string, signal?: AbortSignal, force = false): Promise<RepositoryIndexUpdate> {
  const root = await realpath(resolve(workspace))
  const workspaceId = idFor(root)
  const previous = force ? null : await loadIndex(home, workspaceId)
  const oldFiles = new Map(previous?.files.map((file) => [file.path, file]) ?? [])
  const found = (await findFiles(root, root, '**/*')).filter((file) => !isSensitivePath(file.path) && indexable(file.path)).slice(0, MAX_FILES)
  const files: IndexedRepositoryFile[] = []
  let reused = 0
  let updated = 0
  for (const file of found.sort((a, b) => a.path.localeCompare(b.path))) {
    if (signal?.aborted) throw new Error('Pembuatan indeks dibatalkan.')
    try {
      const actual = await realpath(file.absolute)
      if (!inside(actual, root)) continue
      const info = await stat(actual)
      if (!info.isFile() || info.size > MAX_FILE_BYTES) continue
      const old = oldFiles.get(file.path)
      if (old && old.size === info.size && old.modifiedAt === info.mtimeMs) {
        files.push(old); reused += 1; oldFiles.delete(file.path); continue
      }
      const buffer = await readFile(actual)
      if (buffer.subarray(0, 8_000).includes(0)) continue
      const content = buffer.toString('utf8')
      const extension = extname(file.path).toLowerCase()
      const analysis = SOURCE_EXTENSIONS.has(extension)
        ? await analyzeRepositorySource(content, extension)
        : { symbols: [], calls: [], imports: [], inherits: [], parser: 'fallback' as const }
      files.push({
        path: file.path,
        size: info.size,
        modifiedAt: info.mtimeMs,
        hash: createHash('sha256').update(buffer).digest('hex'),
        symbols: analysis.symbols,
        imports: analysis.parser === 'typescript-ast' ? analysis.imports : fallbackImports(content, extension),
        calls: analysis.calls,
        inherits: analysis.inherits,
        parser: analysis.parser,
        identifiers: identifiers(content),
      })
      updated += 1
      oldFiles.delete(file.path)
    } catch {
      // File berubah/hilang saat dipindai atau symlink tidak aman: lewati.
    }
  }
  const index: RepositoryIndex = { version: INDEX_VERSION, workspaceId, builtAt: Date.now(), files }
  const persisted = await persistIndex(home, index)
  return { index, scanned: found.length, reused, updated, removed: oldFiles.size, persisted }
}

interface SearchArgs { query: string; path?: string; max_results?: number; rebuild?: boolean }
interface Scored {
  file: IndexedRepositoryFile
  score: number
  lines: number[]
  matchedSymbols: RepositorySymbol[]
  matchedImports: string[]
  matchedCalls: RepositoryCall[]
  relatedFiles: string[]
}

/** Resolve import relatif terhadap path yang benar-benar ada pada indeks. */
export function resolveIndexedImport(source: string, dependency: string, paths: ReadonlySet<string>): string | undefined {
  if (!dependency.startsWith('.')) return undefined
  const clean = dependency.split(/[?#]/, 1)[0]
  const base = posix.normalize(posix.join(posix.dirname(source), clean))
  const candidates = [base]
  if (posix.extname(base)) {
    const withoutExtension = base.slice(0, -posix.extname(base).length)
    candidates.push(...[...SOURCE_EXTENSIONS].map((extension) => `${withoutExtension}${extension}`))
  } else {
    candidates.push(...[...SOURCE_EXTENSIONS].map((extension) => `${base}${extension}`))
    candidates.push(...[...SOURCE_EXTENSIONS].map((extension) => `${base}/index${extension}`))
  }
  return candidates.find((candidate) => paths.has(candidate))
}

function scoreFiles(index: RepositoryIndex, query: string, prefix: string): Scored[] {
  const tokens = queryWords(query)
  const phrase = query.toLowerCase().trim()
  const candidates = index.files.filter((file) => !prefix || file.path === prefix || file.path.startsWith(`${prefix}/`))
  const frequencies = new Map(tokens.map((token) => [token, candidates.filter((file) => file.identifiers.some((item) => item.token === token)).length]))
  const scored = candidates.map((file) => {
    const path = file.path.toLowerCase()
    const matchedSymbols = file.symbols.filter((symbol) => tokens.some((token) => symbol.name.toLowerCase().includes(token)))
    const matchedImports = file.imports.filter((dependency) => tokens.some((token) => dependency.toLowerCase().includes(token)))
    const matchedCalls = file.calls.filter((call) => tokens.some((token) => call.name.toLowerCase().includes(token)))
    const byIdentifier = new Map(file.identifiers.map((item) => [item.token, item]))
    let score = path.includes(phrase) ? 45 : 0
    const lines = new Set<number>()
    let directMatches = 0
    for (const token of tokens) {
      if (path.includes(token)) { score += 12; directMatches += 1 }
      const identifier = byIdentifier.get(token)
      if (identifier) {
        const idf = Math.log((candidates.length + 1) / ((frequencies.get(token) ?? 0) + 1)) + 1
        score += Math.min(identifier.count, 8) * idf * 3
        directMatches += 1
        for (const line of identifier.lines.slice(0, 2)) lines.add(line)
      }
    }
    for (const symbol of matchedSymbols) { score += symbol.name.toLowerCase() === phrase ? 35 : 18; lines.add(symbol.line) }
    score += matchedImports.length * 10
    for (const call of matchedCalls.slice(0, 8)) { score += call.name.toLowerCase() === phrase ? 16 : 8; lines.add(call.line) }
    score += file.inherits.filter((name) => tokens.some((token) => name.toLowerCase().includes(token))).length * 14
    if (tokens.length > 1 && directMatches >= Math.min(tokens.length, 2)) score += 14
    if (!tokens.some((token) => token === 'test' || token === 'spec') && /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|\.(?:test|spec)\./i.test(file.path)) score *= 0.75
    return { file, score, lines: [...lines].sort((a, b) => a - b).slice(0, 5), matchedSymbols, matchedImports, matchedCalls, relatedFiles: [] as string[] }
  })

  // Satu langkah propagasi graph cukup untuk mengangkat entry point/pemanggil
  // tanpa membiarkan dependency berantai jauh mendominasi hasil lexical.
  const byPath = new Map(scored.map((entry) => [entry.file.path, entry]))
  const paths = new Set(byPath.keys())
  const bonuses = new Map<Scored, number>()
  for (const source of scored) {
    for (const dependency of source.file.imports) {
      const targetPath = resolveIndexedImport(source.file.path, dependency, paths)
      const target = targetPath ? byPath.get(targetPath) : undefined
      if (!target) continue
      if (source.score > 0) {
        bonuses.set(target, (bonuses.get(target) ?? 0) + Math.min(20, source.score * 0.15))
        target.relatedFiles.push(source.file.path)
      }
      if (target.score > 0) {
        bonuses.set(source, (bonuses.get(source) ?? 0) + Math.min(15, target.score * 0.1))
        source.relatedFiles.push(target.file.path)
      }
    }
  }
  const definitions = new Map<string, Scored[]>()
  for (const entry of scored) {
    for (const symbol of entry.file.symbols) {
      const key = symbol.name.toLowerCase()
      const list = definitions.get(key) ?? []
      if (list.length < 8) list.push(entry)
      definitions.set(key, list)
    }
  }
  for (const source of scored) {
    for (const call of source.file.calls) {
      const targets = definitions.get(call.name.toLowerCase()) ?? []
      for (const target of targets) {
        if (target === source) continue
        if (source.score > 0) {
          bonuses.set(target, (bonuses.get(target) ?? 0) + Math.min(12, source.score * 0.08))
          target.relatedFiles.push(source.file.path)
        }
        if (target.score > 0) {
          bonuses.set(source, (bonuses.get(source) ?? 0) + Math.min(18, target.score * 0.12))
          source.relatedFiles.push(target.file.path)
        }
      }
    }
  }
  for (const [entry, bonus] of bonuses) entry.score += bonus
  return scored.filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path))
}

async function evidence(workspace: string, entry: Scored, fileSnapshots?: FileSnapshots): Promise<string[]> {
  if (!entry.lines.length) return []
  try {
    const target = resolveInWorkspace(workspace, entry.file.path)
    const actual = await realpath(target)
    const root = await realpath(resolve(workspace))
    if (!inside(actual, root)) return []
    const buffer = await readFile(actual)
    fileSnapshots?.observe(target, buffer)
    const lines = buffer.toString('utf8').split('\n')
    return entry.lines.filter((line) => line >= 1 && line <= lines.length).map((line) => {
      const text = lines[line - 1].trim().replace(/\s+/g, ' ')
      return `  ${line}: ${text.length > 240 ? `${text.slice(0, 240)}…` : text}`
    })
  } catch { return [] }
}

export const codeSearchTool: Tool<SearchArgs> = {
  name: 'code_search',
  description: 'Rank relevant source files, symbols, dependencies, and evidence lines using a persistent local repository index. Prefer this for conceptual searches; use grep for exact regex text.',
  risk: 'safe',
  schema: {
    type: 'function',
    function: {
      name: 'code_search',
      description: 'Find code relevant to a concept using path, symbol, identifier, and import/dependency ranking.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Concept, behavior, symbol, or feature to locate' },
          path: { type: 'string', description: 'Optional directory prefix relative to workspace' },
          max_results: { type: 'number', description: 'Maximum files, 1–30; default 12' },
          rebuild: { type: 'boolean', description: 'Force refresh metadata; normally incremental refresh is automatic' },
        },
        required: ['query'],
      },
    },
  },
  preview: (args) => `cari konsep "${args.query}"${args.path ? ` di ${args.path}` : ''}`,
  async run(args, context) {
    const query = typeof args.query === 'string' ? args.query.trim() : ''
    if (!query || query.length > 500) return { content: 'Gagal: query wajib 1–500 karakter.', isError: true }
    let prefix = ''
    if (args.path) {
      try { prefix = relative(context.workspace, resolveInWorkspace(context.workspace, args.path)).split(sep).join('/') } catch (error) {
        return { content: `Gagal: ${error instanceof Error ? error.message : 'path tidak valid'}`, isError: true }
      }
    }
    try {
      if (args.rebuild === true) memoryIndexes.delete(idFor(await realpath(resolve(context.workspace))))
      const update = await updateRepositoryIndex(context.workspace, context.home, context.signal, args.rebuild === true)
      const max = Math.max(1, Math.min(MAX_RESULTS, Number.isFinite(args.max_results) ? Math.floor(args.max_results!) : 12))
      const matches = scoreFiles(update.index, query, prefix).slice(0, max)
      if (!matches.length) return { content: `Tidak ada kode yang relevan dengan "${query}" pada indeks repository.` }
      const output: string[] = []
      for (const match of matches) {
        output.push(`${match.file.path}  [score ${Math.round(match.score)}]`)
        if (match.matchedSymbols.length) output.push(`  symbols: ${match.matchedSymbols.slice(0, 6).map((symbol) => `${symbol.name}@${symbol.line}`).join(', ')}`)
        if (match.matchedImports.length) output.push(`  imports: ${match.matchedImports.slice(0, 5).join(', ')}`)
        if (match.matchedCalls.length) output.push(`  calls: ${match.matchedCalls.slice(0, 6).map((call) => `${call.name}@${call.line}`).join(', ')}`)
        if (match.file.inherits.length) output.push(`  inherits: ${match.file.inherits.slice(0, 5).join(', ')}`)
        if (match.relatedFiles.length) output.push(`  related: ${[...new Set(match.relatedFiles)].slice(0, 5).join(', ')}`)
        output.push(...await evidence(context.workspace, match, context.fileSnapshots))
      }
      const cache = `${update.reused} reused, ${update.updated} updated, ${update.removed} removed${update.persisted ? ', persisted' : ', memory-only'}`
      const astFiles = update.index.files.filter((file) => file.parser === 'typescript-ast').length
      return { content: `${output.join('\n')}\n\n[${update.index.files.length} indexed files; ${astFiles} AST; ${cache}]` }
    } catch (error) {
      return { content: `Gagal: ${error instanceof Error ? error.message : 'indeks repository gagal'}`, isError: true }
    }
  },
}

interface GraphArgs { symbol: string; path?: string; max_results?: number; rebuild?: boolean }
const MAX_GRAPH_RESULTS = 50

function symbolLabel(symbol: RepositorySymbol): string {
  return symbol.container ? `${symbol.container}.${symbol.name}` : symbol.name
}

/** Query graph deklarasi/call AST tanpa memasukkan source penuh ke indeks. */
export const codeGraphTool: Tool<GraphArgs> = {
  name: 'code_graph',
  description: 'Inspect AST-derived definitions, callers, callees, and inheritance for a JavaScript/TypeScript symbol. Other languages retain declaration/import fallback metadata.',
  risk: 'safe',
  schema: {
    type: 'function',
    function: {
      name: 'code_graph',
      description: 'Find where a symbol is defined and called, what it calls, and its inheritance relationships using the local repository syntax graph.',
      parameters: {
        type: 'object',
        properties: {
          symbol: { type: 'string', minLength: 1, maxLength: 200, description: 'Exact symbol or qualified name, such as SessionManager.validateCredentials' },
          path: { type: 'string', description: 'Optional workspace directory prefix' },
          max_results: { type: 'integer', minimum: 1, maximum: MAX_GRAPH_RESULTS, description: 'Maximum rows per graph section; default 20' },
          rebuild: { type: 'boolean', description: 'Force rebuilding the local syntax index' },
        },
        required: ['symbol'],
      },
    },
  },
  preview: (args) => `telusuri graph simbol ${args.symbol}${args.path ? ` di ${args.path}` : ''}`,
  async run(args, context) {
    const requested = typeof args.symbol === 'string' ? args.symbol.trim() : ''
    if (!requested || requested.length > 200 || !/^[A-Za-z_$][\w$]*(?:[.#:][A-Za-z_$][\w$]*)*$/.test(requested)) {
      return { content: 'Gagal: symbol harus berupa nama identifier atau nama qualified yang valid.', isError: true }
    }
    let prefix = ''
    if (args.path) {
      try { prefix = relative(context.workspace, resolveInWorkspace(context.workspace, args.path)).split(sep).join('/') } catch (error) {
        return { content: `Gagal: ${error instanceof Error ? error.message : 'path tidak valid'}`, isError: true }
      }
    }
    try {
      if (args.rebuild === true) memoryIndexes.delete(idFor(await realpath(resolve(context.workspace))))
      const update = await updateRepositoryIndex(context.workspace, context.home, context.signal, args.rebuild === true)
      const files = update.index.files.filter((file) => !prefix || file.path === prefix || file.path.startsWith(`${prefix}/`))
      const normalized = requested.replace(/[:#]/g, '.').toLowerCase()
      const shortName = normalized.split('.').at(-1)!
      const maximum = Math.max(1, Math.min(MAX_GRAPH_RESULTS, Number.isFinite(args.max_results) ? Math.floor(args.max_results!) : 20))
      const definitions = files.flatMap((file) => file.symbols
        .filter((symbol) => symbol.name.toLowerCase() === shortName && (normalized === shortName || symbolLabel(symbol).toLowerCase() === normalized))
        .map((symbol) => ({ file, symbol })))
      const callers = files.flatMap((file) => file.calls
        .filter((call) => call.name.toLowerCase() === shortName)
        .map((call) => ({ file, call })))

      const definitionsByName = new Map<string, Array<{ file: IndexedRepositoryFile; symbol: RepositorySymbol }>>()
      for (const file of files) {
        for (const symbol of file.symbols) {
          const list = definitionsByName.get(symbol.name.toLowerCase()) ?? []
          if (list.length < maximum) list.push({ file, symbol })
          definitionsByName.set(symbol.name.toLowerCase(), list)
        }
      }
      const callees = new Map<string, { calls: Array<{ path: string; line: number }>; definitions: string[] }>()
      for (const definition of definitions) {
        const start = definition.symbol.line
        const end = definition.symbol.endLine ?? start
        const qualified = symbolLabel(definition.symbol)
        for (const call of definition.file.calls) {
          if (call.line < start || call.line > end) continue
          if (call.container && call.container !== qualified && !call.container.startsWith(`${qualified}.`)) continue
          const entry = callees.get(call.name) ?? { calls: [], definitions: [] }
          if (entry.calls.length < maximum) entry.calls.push({ path: definition.file.path, line: call.line })
          for (const target of definitionsByName.get(call.name.toLowerCase()) ?? []) {
            const label = `${target.file.path}:${target.symbol.line}`
            if (entry.definitions.length < maximum && !entry.definitions.includes(label)) entry.definitions.push(label)
          }
          callees.set(call.name, entry)
        }
      }
      const inheritedBy = files.flatMap((file) => file.symbols
        .filter((symbol) => symbol.inherits?.some((base) => base.toLowerCase().split('.').at(-1) === shortName))
        .map((symbol) => ({ file, symbol })))

      if (!definitions.length && !callers.length && !inheritedBy.length) {
        return { content: `Simbol ${requested} tidak ditemukan pada syntax graph${prefix ? ` di ${prefix}` : ''}. Gunakan code_search untuk pencarian konseptual atau grep untuk teks persis.` }
      }
      const output: string[] = [`Symbol graph · ${requested}`]
      output.push('Definitions:')
      output.push(...(definitions.slice(0, maximum).map(({ file, symbol }) =>
        `- ${file.path}:${symbol.line}${symbol.endLine && symbol.endLine !== symbol.line ? `-${symbol.endLine}` : ''} · ${symbol.kind} ${symbolLabel(symbol)}${symbol.exported ? ' [export]' : ''}${symbol.inherits?.length ? ` · extends ${symbol.inherits.join(', ')}` : ''}`)))
      if (!definitions.length) output.push('- (tidak ditemukan; mungkin simbol eksternal atau dinamis)')
      output.push('Callers:')
      output.push(...callers.slice(0, maximum).map(({ file, call }) => `- ${file.path}:${call.line}${call.container ? ` · dalam ${call.container}` : ''}`))
      if (!callers.length) output.push('- (tidak ditemukan)')
      output.push('Callees:')
      for (const [name, value] of [...callees].slice(0, maximum)) {
        output.push(`- ${name} · dipanggil ${value.calls.map((call) => `${call.path}:${call.line}`).join(', ')}${value.definitions.length ? ` · definisi ${value.definitions.join(', ')}` : ''}`)
      }
      if (!callees.size) output.push('- (tidak ditemukan)')
      if (inheritedBy.length) {
        output.push('Inherited by:')
        output.push(...inheritedBy.slice(0, maximum).map(({ file, symbol }) => `- ${file.path}:${symbol.line} · ${symbolLabel(symbol)}`))
      }
      const astFiles = files.filter((file) => file.parser === 'typescript-ast').length
      const cache = `${update.reused} reused, ${update.updated} updated, ${update.removed} removed${update.persisted ? ', persisted' : ', memory-only'}`
      output.push(`[${files.length} indexed files; ${astFiles} TypeScript/JavaScript AST; ${cache}]`)
      return { content: output.join('\n') }
    } catch (error) {
      return { content: `Gagal: ${error instanceof Error ? error.message : 'syntax graph gagal'}`, isError: true }
    }
  },
}
