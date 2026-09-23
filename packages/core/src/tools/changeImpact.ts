/** Graph dampak perubahan dari dependency, call, inheritance, dan konvensi test. */

import type { Tool } from '../domain/tool.ts'
import {
  resolveIndexedImport,
  updateRepositoryIndex,
  type IndexedRepositoryFile,
  type RepositoryIndex,
} from './codeSearch.ts'
import { conventionalTestCandidates, isTestPath, normalizeChangedPath } from './impactPaths.ts'

export { normalizeChangedPath } from './impactPaths.ts'

export const DEFAULT_CHANGE_IMPACT_DEPTH = 4
export const MAX_CHANGE_IMPACT_DEPTH = 6
const MAX_CHANGED_FILES = 100
const MAX_AFFECTED_FILES = 80
const MAX_IMPACT_EDGES = 180
const MAX_AFFECTED_SYMBOLS = 40

export type ChangeImpactRelation = 'imported-by' | 'called-by' | 'inherited-by' | 'conventional-test'
export type ChangeImpactConfidence = 'high' | 'medium'
export type ChangeImpactBlastRadius = 'small' | 'medium' | 'large'

export interface ChangeImpactEdge {
  /** Dependency/definition whose change propagates outward. */
  from: string
  /** Consumer, caller, subclass, or test that may be affected. */
  to: string
  relation: ChangeImpactRelation
  confidence: ChangeImpactConfidence
  symbol?: string
}

export interface ChangeImpactFile {
  path: string
  depth: number
  relations: ChangeImpactRelation[]
  confidence: ChangeImpactConfidence
  test: boolean
}

export interface ChangeImpactSymbol {
  path: string
  name: string
  kind: string
  line: number
}

export interface ChangeImpactGraph {
  changedFiles: string[]
  affectedFiles: ChangeImpactFile[]
  affectedSymbols: ChangeImpactSymbol[]
  edges: ChangeImpactEdge[]
  directTests: string[]
  dependentTests: string[]
  blastRadius: ChangeImpactBlastRadius
  maxDepth: number
  indexedFiles: number
  truncated: boolean
}

function symbolName(file: IndexedRepositoryFile, name: string): string {
  const symbol = file.symbols.find((candidate) => candidate.name === name)
  return symbol?.container ? `${symbol.container}.${symbol.name}` : name
}

function addEdge(edges: Map<string, ChangeImpactEdge>, edge: ChangeImpactEdge): void {
  if (edge.from === edge.to) return
  const key = `${edge.from}\0${edge.to}\0${edge.relation}\0${edge.symbol ?? ''}`
  const previous = edges.get(key)
  if (!previous || (previous.confidence === 'medium' && edge.confidence === 'high')) edges.set(key, edge)
}

function importedDefinitions(source: IndexedRepositoryFile, paths: ReadonlySet<string>): Set<string> {
  return new Set(source.imports
    .map((dependency) => resolveIndexedImport(source.path, dependency, paths))
    .filter((path): path is string => Boolean(path)))
}

/**
 * Graph berarah dari file yang berubah menuju konsumen yang mungkin terdampak.
 * Relasi call/inheritance hanya dipakai bila definisinya unik atau diimpor oleh
 * consumer, agar nama umum seperti `run` tidak membuat blast radius palsu.
 */
export function buildChangeImpactGraph(index: RepositoryIndex, changedFiles: readonly string[], requestedDepth = DEFAULT_CHANGE_IMPACT_DEPTH): ChangeImpactGraph {
  const changed = [...new Set(changedFiles.map(normalizeChangedPath).filter((path): path is string => Boolean(path)))].slice(0, MAX_CHANGED_FILES)
  const maxDepth = Math.max(1, Math.min(MAX_CHANGE_IMPACT_DEPTH, Math.floor(requestedDepth) || DEFAULT_CHANGE_IMPACT_DEPTH))
  const safeFiles = index.files.filter((file) => normalizeChangedPath(file.path) === file.path)
  const paths = new Set(safeFiles.map((file) => file.path))
  const byPath = new Map(safeFiles.map((file) => [file.path, file]))
  const definitions = new Map<string, IndexedRepositoryFile[]>()
  for (const file of safeFiles) {
    for (const symbol of file.symbols) {
      const key = symbol.name.toLowerCase()
      const files = definitions.get(key) ?? []
      if (!files.some((candidate) => candidate.path === file.path)) files.push(file)
      definitions.set(key, files)
    }
  }

  const edges = new Map<string, ChangeImpactEdge>()
  for (const source of safeFiles) {
    const imported = importedDefinitions(source, paths)
    for (const target of imported) addEdge(edges, { from: target, to: source.path, relation: 'imported-by', confidence: 'high' })

    for (const call of source.calls) {
      const candidates = definitions.get(call.name.toLowerCase()) ?? []
      const narrowed = candidates.filter((candidate) => imported.has(candidate.path))
      const targets = narrowed.length ? narrowed : candidates.length === 1 ? candidates : []
      for (const target of targets) addEdge(edges, {
        from: target.path,
        to: source.path,
        relation: 'called-by',
        confidence: narrowed.length ? 'high' : 'medium',
        symbol: symbolName(target, call.name),
      })
    }

    for (const symbol of source.symbols) {
      for (const base of symbol.inherits ?? []) {
        const short = base.split('.').at(-1)?.toLowerCase()
        if (!short) continue
        const candidates = definitions.get(short) ?? []
        const narrowed = candidates.filter((candidate) => imported.has(candidate.path))
        const targets = narrowed.length ? narrowed : candidates.length === 1 ? candidates : []
        for (const target of targets) addEdge(edges, {
          from: target.path,
          to: source.path,
          relation: 'inherited-by',
          confidence: narrowed.length ? 'high' : 'medium',
          symbol: base,
        })
      }
    }
  }

  for (const file of safeFiles) {
    if (isTestPath(file.path)) continue
    for (const candidate of conventionalTestCandidates(file.path)) {
      if (paths.has(candidate)) addEdge(edges, { from: file.path, to: candidate, relation: 'conventional-test', confidence: 'high' })
    }
  }

  const adjacency = new Map<string, ChangeImpactEdge[]>()
  for (const edge of edges.values()) {
    const list = adjacency.get(edge.from) ?? []
    list.push(edge)
    adjacency.set(edge.from, list)
  }
  for (const list of adjacency.values()) list.sort((a, b) => a.to.localeCompare(b.to) || a.relation.localeCompare(b.relation))

  const directTests = new Set<string>()
  const affected = new Map<string, ChangeImpactFile>()
  const queue = changed.map((path) => ({ path, depth: 0 }))
  const bestDepth = new Map(changed.map((path) => [path, 0]))
  const traversedEdges: ChangeImpactEdge[] = []
  let truncated = changedFiles.length > changed.length
  while (queue.length) {
    const current = queue.shift()!
    if (current.depth >= maxDepth) continue
    for (const edge of adjacency.get(current.path) ?? []) {
      const depth = current.depth + 1
      if (traversedEdges.length < MAX_IMPACT_EDGES) traversedEdges.push(edge)
      else truncated = true
      if (edge.relation === 'conventional-test' && changed.includes(edge.from)) directTests.add(edge.to)
      const existing = affected.get(edge.to)
      const confidence: ChangeImpactConfidence = edge.confidence === 'high' && (!existing || existing.confidence === 'high') ? 'high' : 'medium'
      if (!existing) {
        if (affected.size >= MAX_AFFECTED_FILES) { truncated = true; continue }
        affected.set(edge.to, { path: edge.to, depth, relations: [edge.relation], confidence, test: isTestPath(edge.to) })
      } else {
        existing.depth = Math.min(existing.depth, depth)
        if (!existing.relations.includes(edge.relation)) existing.relations.push(edge.relation)
        if (edge.confidence === 'medium') existing.confidence = 'medium'
      }
      const previousDepth = bestDepth.get(edge.to)
      if (previousDepth === undefined || depth < previousDepth) {
        bestDepth.set(edge.to, depth)
        queue.push({ path: edge.to, depth })
      }
    }
  }

  for (const path of changed) if (isTestPath(path) && paths.has(path)) directTests.add(path)
  const affectedFiles = [...affected.values()]
    .filter((file) => !changed.includes(file.path))
    .map((file) => ({ ...file, relations: [...file.relations].sort() }))
    .sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path))
  const dependentTests = affectedFiles.filter((file) => file.test && !directTests.has(file.path)).map((file) => file.path)
  const affectedSymbols = changed.flatMap((path) => (byPath.get(path)?.symbols ?? []).map((symbol) => ({
    path,
    name: symbol.container ? `${symbol.container}.${symbol.name}` : symbol.name,
    kind: symbol.kind,
    line: symbol.line,
  }))).slice(0, MAX_AFFECTED_SYMBOLS)
  if (changed.reduce((sum, path) => sum + (byPath.get(path)?.symbols.length ?? 0), 0) > affectedSymbols.length) truncated = true

  const deepest = affectedFiles.reduce((maximum, file) => Math.max(maximum, file.depth), 0)
  const blastRadius: ChangeImpactBlastRadius = truncated || affectedFiles.length > 20 || deepest > 4
    ? 'large'
    : affectedFiles.length > 5 || deepest > 2
      ? 'medium'
      : 'small'
  return {
    changedFiles: changed,
    affectedFiles,
    affectedSymbols,
    edges: traversedEdges,
    directTests: [...directTests].sort(),
    dependentTests,
    blastRadius,
    maxDepth,
    indexedFiles: index.files.length,
    truncated,
  }
}

export async function analyzeChangeImpact(workspace: string, changedFiles: readonly string[], home?: string, signal?: AbortSignal, maxDepth = DEFAULT_CHANGE_IMPACT_DEPTH): Promise<ChangeImpactGraph> {
  const update = await updateRepositoryIndex(workspace, home, signal)
  return buildChangeImpactGraph(update.index, changedFiles, maxDepth)
}

interface ChangeImpactArgs { changed_files: string[]; max_depth?: number }

function fileSummary(file: ChangeImpactFile): string {
  return `${file.path} (depth ${file.depth}; ${file.relations.join('+')}; ${file.confidence})`
}

export const changeImpactTool: Tool<ChangeImpactArgs> = {
  name: 'change_impact',
  description: 'Build a bounded change-impact graph from changed files to importers, callers, subclasses, and affected tests. Uses the local repository index and never executes code.',
  risk: 'safe',
  schema: {
    type: 'function',
    function: {
      name: 'change_impact',
      description: 'Trace the blast radius of workspace-relative changed files through imports, calls, inheritance, and test relationships.',
      parameters: {
        type: 'object',
        properties: {
          changed_files: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: MAX_CHANGED_FILES, description: 'Workspace-relative files that changed' },
          max_depth: { type: 'integer', minimum: 1, maximum: MAX_CHANGE_IMPACT_DEPTH, description: `Maximum propagation depth; default ${DEFAULT_CHANGE_IMPACT_DEPTH}` },
        },
        required: ['changed_files'],
      },
    },
  },
  preview: (args) => `petakan dampak ${Array.isArray(args.changed_files) ? args.changed_files.length : 0} file`,
  async run(args, context) {
    if (!Array.isArray(args.changed_files) || !args.changed_files.length || args.changed_files.some((path) => typeof path !== 'string')) {
      return { content: 'Gagal: changed_files wajib berupa 1–100 path relatif.', isError: true }
    }
    const normalized = args.changed_files.map(normalizeChangedPath).filter((path): path is string => Boolean(path))
    if (!normalized.length) return { content: 'Gagal: tidak ada path relatif yang aman.', isError: true }
    try {
      const graph = await analyzeChangeImpact(context.workspace, normalized, context.home, context.signal, args.max_depth)
      const direct = graph.affectedFiles.filter((file) => file.depth === 1 && !file.test)
      const transitive = graph.affectedFiles.filter((file) => file.depth > 1 && !file.test)
      const lines = [
        `Change impact graph · blast radius ${graph.blastRadius}`,
        `File berubah: ${graph.changedFiles.join(', ')}`,
        `Simbol berubah: ${graph.affectedSymbols.length ? graph.affectedSymbols.map((symbol) => `${symbol.name}@${symbol.path}:${symbol.line}`).join(', ') : '(tidak ditemukan)'}`,
        `Konsumen langsung: ${direct.length ? direct.map(fileSummary).join(', ') : '(tidak ditemukan)'}`,
        `Konsumen transitif: ${transitive.length ? transitive.map(fileSummary).join(', ') : '(tidak ditemukan)'}`,
        `Test terdampak: ${[...graph.directTests, ...graph.dependentTests].join(', ') || '(tidak ditemukan)'}`,
        `Graph: ${graph.affectedFiles.length + graph.changedFiles.length} node · ${graph.edges.length} edge · depth ≤ ${graph.maxDepth}`,
        `[${graph.indexedFiles} indexed files${graph.truncated ? '; hasil dibatasi' : ''}]`,
      ]
      return { content: lines.join('\n') }
    } catch (error) {
      return { content: `Gagal: ${error instanceof Error ? error.message : 'analisis dampak perubahan gagal'}`, isError: true }
    }
  },
}
