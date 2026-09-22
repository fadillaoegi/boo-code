/** Analisis test yang terdampak perubahan, berbasis path dan graph import lokal. */

import { access, readFile } from 'node:fs/promises'
import { basename, dirname, extname, join, posix } from 'node:path'
import type { Tool } from '../domain/tool.ts'
import { resolveIndexedImport, updateRepositoryIndex, type RepositoryIndex } from './codeSearch.ts'

const MAX_CHANGED_FILES = 100
const MAX_RELATED_TESTS = 20
const MAX_COMMANDS = 6
const MAX_GRAPH_DEPTH = 4

export interface VerificationCommand {
  label: string
  command: string
  source: string
}

export interface VerificationImpact {
  changedFiles: string[]
  directTests: string[]
  dependentTests: string[]
  commands: VerificationCommand[]
  indexedFiles: number
  truncated: boolean
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true } catch { return false }
}

async function text(path: string): Promise<string> {
  try { return await readFile(path, 'utf8') } catch { return '' }
}

function normalizedPath(value: string): string | undefined {
  const clean = value.replaceAll('\\', '/').replace(/^\.\//, '')
  if (!clean || clean.startsWith('/') || clean === '..' || clean.startsWith('../') || clean.includes('/../') || clean.includes('\0')) return undefined
  return posix.normalize(clean)
}

export function isTestPath(path: string): boolean {
  const name = basename(path)
  return /(?:^|\/)(?:test|tests|__tests__|spec)(?:\/|$)/i.test(path)
    || /(?:\.test|\.spec)\.[^.]+$/i.test(name)
    || /(?:_test\.go|_test\.py|_spec\.rb|Test\.(?:java|kt|php|cs)|Tests\.swift)$/i.test(name)
}

/** Kandidat berbasis konvensi; hanya kandidat yang ada di indeks yang digunakan. */
export function conventionalTestCandidates(path: string): string[] {
  const extension = extname(path)
  if (!extension) return []
  const directory = dirname(path) === '.' ? '' : dirname(path)
  const filename = basename(path, extension)
  const sibling = (name: string) => directory ? `${directory}/${name}` : name
  const candidates = new Set<string>()

  if (/\.(?:[cm]?[jt]sx?|vue|svelte)$/i.test(extension)) {
    for (const suffix of ['test', 'spec']) {
      candidates.add(sibling(`${filename}.${suffix}${extension}`))
      candidates.add(sibling(`__tests__/${filename}.${suffix}${extension}`))
    }
    const relative = path.replace(/^(?:src|lib|app)\//, '')
    const testDirectory = dirname(relative) === '.' ? '' : `${dirname(relative)}/`
    const testName = basename(relative, extension)
    for (const root of ['test', 'tests']) for (const suffix of ['test', 'spec']) candidates.add(`${root}/${testDirectory}${testName}.${suffix}${extension}`)
  } else if (extension === '.go') {
    candidates.add(sibling(`${filename}_test.go`))
  } else if (extension === '.py') {
    candidates.add(sibling(`test_${filename}.py`))
    candidates.add(sibling(`${filename}_test.py`))
    const relative = path.replace(/^(?:src|lib|app)\//, '')
    const testDirectory = dirname(relative) === '.' ? '' : `${dirname(relative)}/`
    candidates.add(`tests/${testDirectory}test_${basename(relative, extension)}.py`)
    candidates.add(`test/${testDirectory}test_${basename(relative, extension)}.py`)
  } else if (extension === '.dart') {
    const relative = path.replace(/^lib\//, '')
    candidates.add(`test/${relative.slice(0, -extension.length)}_test.dart`)
    candidates.add(sibling(`${filename}_test.dart`))
  } else if (/\.(?:java|kt|cs|php)$/i.test(extension)) {
    candidates.add(sibling(`${filename}Test${extension}`))
    const testTree = path.replace(/^src\/main\//, 'src/test/')
    candidates.add(`${testTree.slice(0, -extension.length)}Test${extension}`)
    const relative = path.replace(/^(?:src|app|lib)\//, '')
    candidates.add(`tests/${relative.slice(0, -extension.length)}Test${extension}`)
  } else if (extension === '.rb') {
    candidates.add(sibling(`${filename}_spec.rb`))
    candidates.add(sibling(`${filename}_test.rb`))
    const relative = path.replace(/^(?:lib|app)\//, '')
    candidates.add(`spec/${relative.slice(0, -3)}_spec.rb`)
    candidates.add(`test/${relative.slice(0, -3)}_test.rb`)
  } else if (extension === '.rs') {
    candidates.add(`tests/${filename}.rs`)
  } else if (extension === '.swift') {
    candidates.add(sibling(`${filename}Tests.swift`))
  }
  return [...candidates]
}

function reverseDependencyTests(index: RepositoryIndex, changed: ReadonlySet<string>): string[] {
  const paths = new Set(index.files.map((file) => file.path))
  const reverse = new Map<string, Set<string>>()
  for (const file of index.files) {
    for (const dependency of file.imports) {
      const target = resolveIndexedImport(file.path, dependency, paths)
      if (!target) continue
      const importers = reverse.get(target) ?? new Set<string>()
      importers.add(file.path)
      reverse.set(target, importers)
    }
  }

  const queue = [...changed].map((path) => ({ path, depth: 0 }))
  const visited = new Set(changed)
  const tests = new Set<string>()
  while (queue.length) {
    const current = queue.shift()!
    if (current.depth >= MAX_GRAPH_DEPTH) continue
    for (const importer of reverse.get(current.path) ?? []) {
      if (visited.has(importer)) continue
      visited.add(importer)
      if (isTestPath(importer)) tests.add(importer)
      else queue.push({ path: importer, depth: current.depth + 1 })
    }
  }
  return [...tests].sort()
}

function safePathArgument(path: string): boolean {
  return /^[a-zA-Z0-9_./@+-]+$/.test(path)
}

async function packageTestCommand(workspace: string): Promise<VerificationCommand | undefined> {
  if (!await exists(join(workspace, 'package.json'))) return undefined
  let scripts: Record<string, unknown> = {}
  try { scripts = (JSON.parse(await text(join(workspace, 'package.json'))) as { scripts?: Record<string, unknown> }).scripts ?? {} } catch { return undefined }
  const name = ['test', 'test:unit', 'unit', 'test:ci'].find((candidate) => typeof scripts[candidate] === 'string')
  if (!name) return undefined
  const runner = await exists(join(workspace, 'pnpm-lock.yaml')) ? 'pnpm run'
    : await exists(join(workspace, 'yarn.lock')) ? 'yarn run'
      : await exists(join(workspace, 'bun.lock')) || await exists(join(workspace, 'bun.lockb')) ? 'bun run'
        : 'npm run'
  return { label: `Project test (${name})`, command: `${runner} ${name}`, source: 'package.json' }
}

/** Menemukan command dari manifest/config, tidak dari isi prompt atau tebakan model. */
export async function detectProjectTestCommands(workspace: string, changedFiles: readonly string[], tests: readonly string[]): Promise<VerificationCommand[]> {
  const commands: VerificationCommand[] = []
  const packageCommand = await packageTestCommand(workspace)
  if (packageCommand) commands.push(packageCommand)

  if (await exists(join(workspace, 'go.mod'))) {
    const packages = [...new Set(changedFiles.filter((path) => path.endsWith('.go')).map((path) => dirname(path) === '.' ? '.' : `./${dirname(path)}`))]
    const targets = packages.length && packages.length <= 4 && packages.every(safePathArgument) ? packages.join(' ') : './...'
    commands.push({ label: 'Go tests', command: `go test ${targets}`, source: 'go.mod' })
  }
  if (await exists(join(workspace, 'Cargo.toml'))) commands.push({ label: 'Rust tests', command: 'cargo test', source: 'Cargo.toml' })

  if (await exists(join(workspace, 'pubspec.yaml'))) {
    const pubspec = await text(join(workspace, 'pubspec.yaml'))
    const targets = tests.filter((path) => path.endsWith('_test.dart') && safePathArgument(path)).slice(0, 5)
    const runtime = /^\s*flutter\s*:/m.test(pubspec) ? 'flutter' : 'dart'
    commands.push({ label: `${runtime === 'flutter' ? 'Flutter' : 'Dart'} tests`, command: `${runtime} test${targets.length ? ` ${targets.join(' ')}` : ''}`, source: 'pubspec.yaml' })
  }

  const pyproject = await text(join(workspace, 'pyproject.toml'))
  const pytestConfigured = /\[tool\.pytest(?:\.|\])/m.test(pyproject)
    || await exists(join(workspace, 'pytest.ini'))
    || /\[pytest\]/m.test(await text(join(workspace, 'setup.cfg')))
    || /\[pytest\]/m.test(await text(join(workspace, 'tox.ini')))
  if (pytestConfigured) {
    const targets = tests.filter((path) => path.endsWith('.py') && safePathArgument(path)).slice(0, 5)
    commands.push({ label: 'Python tests', command: `python -m pytest${targets.length ? ` ${targets.join(' ')}` : ''}`, source: 'pytest config' })
  }

  if (await exists(join(workspace, 'gradlew')) || await exists(join(workspace, 'gradlew.bat'))) {
    commands.push({ label: 'Gradle tests', command: process.platform === 'win32' ? '.\\gradlew.bat test' : './gradlew test', source: 'Gradle wrapper' })
  } else if (await exists(join(workspace, 'pom.xml'))) {
    const wrapper = process.platform === 'win32' ? '.\\mvnw.cmd' : './mvnw'
    commands.push({ label: 'Maven tests', command: await exists(join(workspace, process.platform === 'win32' ? 'mvnw.cmd' : 'mvnw')) ? `${wrapper} test` : 'mvn test', source: 'pom.xml' })
  }

  return commands.filter((entry, index) => commands.findIndex((other) => other.command === entry.command) === index).slice(0, MAX_COMMANDS)
}

export async function analyzeVerificationImpact(workspace: string, changedFiles: readonly string[], home?: string, signal?: AbortSignal): Promise<VerificationImpact> {
  const changed = [...new Set(changedFiles.map(normalizedPath).filter((path): path is string => Boolean(path)))].slice(0, MAX_CHANGED_FILES)
  const update = await updateRepositoryIndex(workspace, home, signal)
  const indexedPaths = new Set(update.index.files.map((file) => file.path))
  const direct = new Set<string>()
  for (const path of changed) {
    if (isTestPath(path) && indexedPaths.has(path)) direct.add(path)
    for (const candidate of conventionalTestCandidates(path)) if (indexedPaths.has(candidate)) direct.add(candidate)
  }
  const dependent = reverseDependencyTests(update.index, new Set(changed)).filter((path) => !direct.has(path))
  const allTests = [...direct, ...dependent].slice(0, MAX_RELATED_TESTS)
  const commands = await detectProjectTestCommands(workspace, changed, allTests)
  return {
    changedFiles: changed,
    directTests: [...direct].sort().slice(0, MAX_RELATED_TESTS),
    dependentTests: dependent.slice(0, Math.max(0, MAX_RELATED_TESTS - direct.size)),
    commands,
    indexedFiles: update.index.files.length,
    truncated: changedFiles.length > changed.length || direct.size + dependent.length > MAX_RELATED_TESTS,
  }
}

interface TestImpactArgs { changed_files: string[] }

export const testImpactTool: Tool<TestImpactArgs> = {
  name: 'test_impact',
  description: 'Find tests and project-configured test commands related to changed files using naming conventions and the local reverse dependency graph. This only analyzes; it never runs tests.',
  risk: 'safe',
  schema: {
    type: 'function',
    function: {
      name: 'test_impact',
      description: 'Analyze which tests and detected test commands are relevant to a set of changed files.',
      parameters: {
        type: 'object',
        properties: {
          changed_files: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: MAX_CHANGED_FILES, description: 'Workspace-relative files that changed' },
        },
        required: ['changed_files'],
      },
    },
  },
  preview: (args) => `analisis test untuk ${Array.isArray(args.changed_files) ? args.changed_files.length : 0} file`,
  async run(args, context) {
    if (!Array.isArray(args.changed_files) || !args.changed_files.length || args.changed_files.some((path) => typeof path !== 'string')) {
      return { content: 'Gagal: changed_files wajib berupa 1–100 path relatif.', isError: true }
    }
    try {
      const impact = await analyzeVerificationImpact(context.workspace, args.changed_files, context.home, context.signal)
      const lines = [
        `File berubah: ${impact.changedFiles.join(', ') || '(tidak ada path valid)'}`,
        `Test langsung: ${impact.directTests.join(', ') || '(tidak ditemukan)'}`,
        `Test via dependency: ${impact.dependentTests.join(', ') || '(tidak ditemukan)'}`,
        `Command terdeteksi: ${impact.commands.length ? impact.commands.map((entry) => `${entry.command} [${entry.source}]`).join('; ') : '(tidak ditemukan)'}`,
        `[${impact.indexedFiles} indexed files${impact.truncated ? '; hasil dibatasi' : ''}]`,
      ]
      return { content: lines.join('\n') }
    } catch (error) {
      return { content: `Gagal: ${error instanceof Error ? error.message : 'analisis dampak test gagal'}`, isError: true }
    }
  },
}
