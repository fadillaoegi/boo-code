import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { analyzeRepositorySource, extractRepositorySymbols, repoMapTool } from '../src/tools/repoMap.ts'

test('ekstraksi simbol mengenali deklarasi beberapa bahasa dan nomor baris', () => {
  assert.deepEqual(extractRepositorySymbols('import x from "x"\nexport class Agent {}\nasync function run() {}\n', '.ts'), [
    { line: 2, endLine: 2, kind: 'class', name: 'Agent', exported: true },
    { line: 3, endLine: 3, kind: 'function', name: 'run' },
  ])
  assert.deepEqual(extractRepositorySymbols('class Worker:\n    async def execute(self):\n        pass\n', '.py'), [
    { line: 1, kind: 'class', name: 'Worker' },
    { line: 2, kind: 'def', name: 'execute' },
  ])
  assert.deepEqual(extractRepositorySymbols('type Server struct {}\nfunc (s *Server) Start() {}\n', '.go'), [
    { line: 1, kind: 'type', name: 'Server' },
    { line: 2, kind: 'func', name: 'Start' },
  ])
})

test('parser TypeScript membangun simbol bertingkat, call, import, dan inheritance', () => {
  const analysis = analyzeRepositorySource([
    "import { loadUser } from './repository'",
    'export class SessionManager extends BaseSession implements Runnable {',
    '  async validateCredentials(id: string) { return loadUser(id) }',
    '}',
    'export const createSession = () => new SessionManager()',
  ].join('\n'), '.ts')

  assert.equal(analysis.parser, 'typescript-ast')
  assert.deepEqual(analysis.imports, ['./repository'])
  assert.deepEqual(analysis.inherits, ['BaseSession', 'Runnable'])
  assert.ok(analysis.symbols.some((symbol) => symbol.kind === 'class' && symbol.name === 'SessionManager' && symbol.exported && symbol.inherits?.includes('BaseSession')))
  assert.ok(analysis.symbols.some((symbol) => symbol.kind === 'method' && symbol.container === 'SessionManager' && symbol.name === 'validateCredentials'))
  assert.ok(analysis.symbols.some((symbol) => symbol.kind === 'const' && symbol.name === 'createSession' && symbol.exported))
  assert.ok(analysis.calls.some((call) => call.name === 'loadUser' && call.container === 'SessionManager.validateCredentials'))
  assert.ok(analysis.calls.some((call) => call.name === 'SessionManager' && call.container === 'createSession'))
})

async function fixture(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), 'boo-repo-map-'))
  await mkdir(join(workspace, 'src'))
  await writeFile(join(workspace, 'package.json'), '{"name":"contoh"}\n')
  await writeFile(join(workspace, 'src', 'router.ts'), [
    'export interface RouteOptions {}',
    'export class ModelRouter {}',
    'export function selectModel() {}',
    '',
  ].join('\n'))
  await writeFile(join(workspace, 'src', 'worker.py'), 'class BackgroundWorker:\n    def run(self):\n        pass\n')
  await writeFile(join(workspace, '.env'), 'SECRET=jangan-bocor\n')
  return workspace
}

test('repo_map memberi outline ringkas dan melewati file rahasia', async () => {
  const workspace = await fixture()
  const result = await repoMapTool.run({}, { workspace })
  assert.equal(result.isError, undefined)
  assert.match(result.content, /package\.json {2}\[manifest\]/)
  assert.match(result.content, /src\/router\.ts[\s\S]*2: class ModelRouter/)
  assert.match(result.content, /src\/worker\.py[\s\S]*1: class BackgroundWorker/)
  assert.doesNotMatch(result.content, /SECRET|\.env/)
})

test('query memfokuskan map berdasarkan path dan nama simbol', async () => {
  const workspace = await fixture()
  const result = await repoMapTool.run({ query: 'model router' }, { workspace })
  assert.match(result.content, /src\/router\.ts/)
  assert.match(result.content, /ModelRouter/)
  assert.doesNotMatch(result.content, /worker\.py|package\.json/)
})

test('path dan batas jumlah file menjaga hasil tetap kecil', async () => {
  const workspace = await fixture()
  const result = await repoMapTool.run({ path: 'src', max_files: 1 }, { workspace })
  const paths = result.content.split('\n').filter((line) => /^(?:src\/)/.test(line))
  assert.equal(paths.length, 1)
  assert.match(result.content, /gunakan query atau path untuk mempersempit/)
})
