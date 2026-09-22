import { readFile, stat } from 'node:fs/promises'
import { extname, relative, sep } from 'node:path'
import * as ts from 'typescript'
import type { Tool } from '../domain/tool.ts'
import { findFiles, type FoundFile } from './search.ts'
import { isSensitivePath } from './secrets.ts'
import { resolveInWorkspace } from './workspace.ts'

const SOURCE_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.cs', '.dart', '.ex', '.exs', '.go', '.h', '.hpp', '.java', '.js', '.jsx',
  '.kt', '.kts', '.mjs', '.mts', '.php', '.py', '.rb', '.rs', '.scala', '.swift', '.svelte', '.ts',
  '.tsx', '.vue',
])
const IMPORTANT_FILES = new Set([
  'package.json', 'pyproject.toml', 'go.mod', 'cargo.toml', 'pubspec.yaml', 'pom.xml', 'build.gradle',
  'build.gradle.kts', 'composer.json', 'gemfile', 'makefile', 'cmakelists.txt',
])
const MAX_FILE_BYTES = 512_000
const MAX_SCAN_FILES = 2_000
const MAX_TOTAL_BYTES = 8_000_000
const MAX_SYMBOLS_PER_FILE = 120
const MAX_CALLS_PER_FILE = 240
const TYPESCRIPT_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts'])

export interface RepositorySymbol {
  line: number
  endLine?: number
  kind: string
  name: string
  container?: string
  exported?: boolean
  inherits?: string[]
}
export interface RepositoryCall { line: number; name: string; container?: string }
export interface RepositoryAnalysis {
  symbols: RepositorySymbol[]
  calls: RepositoryCall[]
  imports: string[]
  inherits: string[]
  parser: 'typescript-ast' | 'fallback'
}
interface MapEntry { path: string; absolute: string; buffer: Buffer; symbols: RepositorySymbol[]; important: boolean; score: number }

function scriptKind(extension: string): ts.ScriptKind {
  if (extension === '.tsx') return ts.ScriptKind.TSX
  if (extension === '.jsx') return ts.ScriptKind.JSX
  if (['.js', '.mjs'].includes(extension)) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

function lineRange(source: ts.SourceFile, node: ts.Node): { line: number; endLine: number } {
  return {
    line: source.getLineAndCharacterOfPosition(node.getStart(source, false)).line + 1,
    endLine: source.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
  }
}

function declarationName(name: ts.DeclarationName | ts.BindingName | undefined): string | null {
  if (!name) return null
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text
  return null
}

function exported(node: ts.Node): boolean {
  const target = ts.isVariableDeclaration(node) && ts.isVariableStatement(node.parent.parent) ? node.parent.parent : node
  return ts.canHaveModifiers(target) && Boolean(ts.getModifiers(target)?.some((modifier) =>
    modifier.kind === ts.SyntaxKind.ExportKeyword || modifier.kind === ts.SyntaxKind.DefaultKeyword))
}

function callName(expression: ts.LeftHandSideExpression): string | null {
  if (ts.isIdentifier(expression)) return expression.text
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text
  if (ts.isElementAccessExpression(expression) && expression.argumentExpression && (ts.isStringLiteral(expression.argumentExpression) || ts.isNumericLiteral(expression.argumentExpression))) {
    return expression.argumentExpression.text
  }
  return null
}

function analyzeTypeScript(content: string, extension: string): RepositoryAnalysis {
  const source = ts.createSourceFile(`source${extension}`, content, ts.ScriptTarget.Latest, true, scriptKind(extension))
  const symbols: RepositorySymbol[] = []
  const calls: RepositoryCall[] = []
  const imports = new Set<string>()
  const inherits = new Set<string>()

  const addSymbol = (node: ts.Node, kind: string, name: string | null, container?: string, heritage: string[] = []): string | undefined => {
    if (!name || symbols.length >= MAX_SYMBOLS_PER_FILE) return container
    const range = lineRange(source, node)
    symbols.push({ ...range, kind, name, ...(container ? { container } : {}), ...(exported(node) ? { exported: true } : {}), ...(heritage.length ? { inherits: heritage } : {}) })
    return container ? `${container}.${name}` : name
  }

  const visit = (node: ts.Node, container?: string): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier
      if (specifier && ts.isStringLiteral(specifier) && specifier.text.length <= 200) imports.add(specifier.text)
    }

    let childContainer = container
    if (ts.isClassDeclaration(node)) {
      const heritage: string[] = []
      for (const clause of node.heritageClauses ?? []) {
        for (const type of clause.types) {
          const name = type.expression.getText(source).slice(0, 128)
          if (name) { inherits.add(name); heritage.push(name) }
        }
      }
      childContainer = addSymbol(node, 'class', declarationName(node.name), container, heritage)
    } else if (ts.isInterfaceDeclaration(node)) {
      const heritage: string[] = []
      for (const clause of node.heritageClauses ?? []) {
        for (const type of clause.types) {
          const name = type.expression.getText(source).slice(0, 128)
          if (name) { inherits.add(name); heritage.push(name) }
        }
      }
      childContainer = addSymbol(node, 'interface', declarationName(node.name), container, heritage)
    } else if (ts.isTypeAliasDeclaration(node)) {
      addSymbol(node, 'type', declarationName(node.name), container)
    } else if (ts.isEnumDeclaration(node)) {
      childContainer = addSymbol(node, 'enum', declarationName(node.name), container)
    } else if (ts.isFunctionDeclaration(node)) {
      childContainer = addSymbol(node, 'function', declarationName(node.name), container)
    } else if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) {
      childContainer = addSymbol(node, 'method', declarationName(node.name), container)
    } else if (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
      childContainer = addSymbol(node, ts.isGetAccessorDeclaration(node) ? 'getter' : 'setter', declarationName(node.name), container)
    } else if (ts.isVariableDeclaration(node) && ts.isVariableStatement(node.parent.parent) && ts.isSourceFile(node.parent.parent.parent)) {
      const flags = node.parent.flags
      const kind = flags & ts.NodeFlags.Const ? 'const' : flags & ts.NodeFlags.Let ? 'let' : 'var'
      const name = declarationName(node.name)
      const scope = addSymbol(node, kind, name, container)
      if (node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) childContainer = scope
    }

    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const name = callName(node.expression)
      if (name && calls.length < MAX_CALLS_PER_FILE) calls.push({ line: lineRange(source, node).line, name, ...(container ? { container } : {}) })
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const argument = node.arguments[0]
        if (argument && ts.isStringLiteral(argument) && argument.text.length <= 200) imports.add(argument.text)
      } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        const argument = node.arguments[0]
        if (argument && ts.isStringLiteral(argument) && argument.text.length <= 200) imports.add(argument.text)
      }
    }

    ts.forEachChild(node, (child) => visit(child, childContainer))
  }
  visit(source)
  return { symbols, calls, imports: [...imports].slice(0, 80), inherits: [...inherits].slice(0, 80), parser: 'typescript-ast' }
}

function languagePattern(extension: string): RegExp[] {
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts', '.vue', '.svelte'].includes(extension)) {
    // Hanya deklarasi top-level. Mencatat `const` lokal membuat map dipenuhi
    // detail implementasi dan menenggelamkan API/modul yang dicari model.
    return [/^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(class|function|interface|type|enum|namespace|const|let|var)\s+([A-Za-z_$][\w$]*)/]
  }
  if (extension === '.py') return [/^\s*(?:(async)\s+)?(class|def)\s+([A-Za-z_]\w*)/]
  if (extension === '.go') return [/^\s*(type)\s+([A-Za-z_]\w*)/, /^\s*(func)\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/]
  if (extension === '.rs') return [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(struct|enum|trait|fn|type|mod)\s+([A-Za-z_]\w*)/]
  if (['.java', '.kt', '.kts', '.scala', '.swift', '.cs', '.dart'].includes(extension)) {
    return [/^\s*(?:(?:public|private|protected|internal|open|abstract|sealed|static|final|data|export)\s+)*(class|interface|enum|struct|protocol|extension|fun|func|record|typealias)\s+([A-Za-z_]\w*)/]
  }
  if (extension === '.rb') return [/^\s*(class|module|def)\s+(?:self\.)?([A-Za-z_]\w*[!?=]?)/]
  if (['.ex', '.exs'].includes(extension)) return [/^\s*(defmodule|defprotocol|defimpl|def|defp)\s+([A-Za-z_][\w.!?]*)/]
  if (extension === '.php') return [/^\s*(?:(?:abstract|final|public|protected|private|static)\s+)*(class|interface|trait|enum|function)\s+([A-Za-z_]\w*)/i]
  if (['.c', '.cc', '.cpp', '.h', '.hpp'].includes(extension)) {
    return [/^\s*(?:class|struct|enum)\s+([A-Za-z_]\w*)/, /^\s*[\w:<>,*&\s]+\s+([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:const\s*)?\{/]
  }
  return []
}

/** Fallback lintas bahasa ketika parser AST TypeScript tidak berlaku. */
function extractFallbackSymbols(content: string, extension: string): RepositorySymbol[] {
  const patterns = languagePattern(extension.toLowerCase())
  if (!patterns.length) return []
  const symbols: RepositorySymbol[] = []
  const lines = content.split('\n')
  for (let index = 0; index < lines.length && symbols.length < MAX_SYMBOLS_PER_FILE; index += 1) {
    for (const pattern of patterns) {
      const match = pattern.exec(lines[index])
      if (!match) continue
      // Python memiliki grup async opsional; C/C++ hanya menangkap nama.
      const captures = match.slice(1).filter(Boolean)
      const name = captures.at(-1)!
      const kind = captures.length > 1 ? captures.at(-2)! : extension.match(/^[.](?:c|cc|cpp|h|hpp)$/) ? 'declaration' : 'symbol'
      if (['if', 'for', 'while', 'switch', 'catch'].includes(name)) continue
      symbols.push({ line: index + 1, kind, name })
      break
    }
  }
  return symbols
}

/** Analisis AST untuk JS/TS; bahasa lain tetap memakai extractor deklarasi konservatif. */
export function analyzeRepositorySource(content: string, extension: string): RepositoryAnalysis {
  const normalized = extension.toLowerCase()
  if (TYPESCRIPT_EXTENSIONS.has(normalized)) return analyzeTypeScript(content, normalized)
  return { symbols: extractFallbackSymbols(content, normalized), calls: [], imports: [], inherits: [], parser: 'fallback' }
}

export function extractRepositorySymbols(content: string, extension: string): RepositorySymbol[] {
  return analyzeRepositorySource(content, extension).symbols
}

function words(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9_$]+/)
    .filter((word) => word.length > 1)
}

function relevance(path: string, symbols: RepositorySymbol[], query: string): number {
  if (!query.trim()) return 1
  const phrase = query.toLowerCase()
  const pathText = path.toLowerCase()
  const symbolText = symbols.map((symbol) => `${symbol.kind} ${symbol.container ?? ''} ${symbol.name}`).join(' ').toLowerCase()
  const queryWords = [...new Set(words(query))]
  const indexedWords = new Set(words(`${path} ${symbols.map((symbol) => `${symbol.container ?? ''} ${symbol.name}`).join(' ')}`))
  let score = pathText.includes(phrase) ? 20 : symbolText.includes(phrase) ? 16 : 0
  for (const word of queryWords) {
    if (pathText.includes(word)) score += 5
    if (symbolText.includes(word)) score += 3
  }
  if (queryWords.length > 1 && queryWords.every((word) => indexedWords.has(word))) score += 15
  return score
}

function isImportant(path: string): boolean {
  return IMPORTANT_FILES.has(path.split('/').at(-1)?.toLowerCase() ?? '')
}

async function candidates(workspace: string, target: string, requestedPath: string): Promise<FoundFile[]> {
  const info = await stat(target)
  if (info.isFile()) return [{ path: relative(workspace, target).split(sep).join('/') || requestedPath, absolute: target, modifiedAt: info.mtimeMs }]
  return findFiles(workspace, target, '**/*')
}

interface RepoMapArgs { path?: string; query?: string; max_files?: number }

export const repoMapTool: Tool<RepoMapArgs> = {
  name: 'repo_map',
  description: 'Build a compact, read-only map of source files and declarations with line numbers. Use it to understand an unfamiliar or cross-module repository before opening files; query narrows the map by path or symbol words.',
  risk: 'safe',
  parallelSafe: true,
  schema: {
    type: 'function',
    function: {
      name: 'repo_map',
      description: 'Map source files and named declarations without reading whole files into context.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File or directory relative to the workspace root; defaults to the root' },
          query: { type: 'string', description: 'Optional words to rank and filter matching file paths or symbols' },
          max_files: { type: 'number', description: 'Maximum files returned, 1–200; default 80' },
        },
      },
    },
  },
  preview: (args) => args.query ? `petakan repository untuk "${args.query}"` : `petakan ${args.path || 'repository'}`,
  async run(args, context) {
    const requestedPath = args.path || '.'
    const target = resolveInWorkspace(context.workspace, requestedPath)
    let files: FoundFile[]
    try {
      files = await candidates(context.workspace, target, requestedPath)
    } catch (error) {
      return { content: `Gagal: ${error instanceof Error ? error.message : 'path tidak dapat dipetakan'}`, isError: true }
    }
    const entries: MapEntry[] = []
    let bytes = 0
    let scanned = 0
    let capped = files.length > MAX_SCAN_FILES
    for (const file of files.slice(0, MAX_SCAN_FILES).sort((a, b) => a.path.localeCompare(b.path))) {
      if (context.signal?.aborted) return { content: 'Dibatalkan: pemetaan repository dihentikan pengguna.', isError: true }
      if (isSensitivePath(file.path)) continue
      const extension = extname(file.path).toLowerCase()
      const important = isImportant(file.path)
      if (!important && !SOURCE_EXTENSIONS.has(extension)) continue
      try {
        const info = await stat(file.absolute)
        if (info.size > MAX_FILE_BYTES || bytes + info.size > MAX_TOTAL_BYTES) { capped = true; continue }
        const buffer = await readFile(file.absolute)
        if (buffer.subarray(0, 8_000).includes(0)) continue
        bytes += buffer.length
        scanned += 1
        const symbols = important ? [] : extractRepositorySymbols(buffer.toString('utf8'), extension)
        const score = relevance(file.path, symbols, args.query ?? '')
        if (score > 0 && (important || symbols.length || args.query)) entries.push({ path: file.path, absolute: file.absolute, buffer, symbols, important, score })
      } catch {
        // File dapat hilang atau berubah saat indeks dibuat; lewati dan lanjutkan.
      }
    }
    entries.sort((a, b) => b.score - a.score || Number(b.important) - Number(a.important) || a.path.localeCompare(b.path))
    const maxFiles = Math.max(1, Math.min(200, Number.isFinite(args.max_files) ? Math.floor(args.max_files!) : 80))
    const shown = entries.slice(0, maxFiles)
    if (!shown.length) {
      return { content: args.query ? `Tidak ada path atau simbol yang cocok dengan "${args.query}".` : 'Tidak ada source file yang dapat dipetakan.' }
    }
    const lines: string[] = []
    for (const entry of shown) {
      context.fileSnapshots?.observe(entry.absolute, entry.buffer)
      lines.push(entry.important ? `${entry.path}  [manifest]` : entry.path)
      for (const symbol of entry.symbols) lines.push(`  ${symbol.line}: ${symbol.kind} ${symbol.container ? `${symbol.container}.` : ''}${symbol.name}${symbol.exported ? ' [export]' : ''}`)
    }
    const astFiles = shown.filter((entry) => TYPESCRIPT_EXTENSIONS.has(extname(entry.path).toLowerCase())).length
    const notes: string[] = [`${shown.length} dari ${entries.length} file relevan; ${scanned} file dipindai`, `${astFiles} file memakai AST`]
    if (entries.length > shown.length) notes.push('gunakan query atau path untuk mempersempit')
    if (capped) notes.push('pemindaian dibatasi untuk menjaga konteks dan performa')
    return { content: `${lines.join('\n')}\n\n[${notes.join('; ')}]` }
  },
}
