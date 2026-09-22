import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codeGraphTool, codeSearchTool, updateRepositoryIndex } from '../src/tools/codeSearch.ts'

function fixture() {
  const workspace = mkdtempSync(join(tmpdir(), 'boo-code-search-'))
  const home = mkdtempSync(join(tmpdir(), 'boo-code-search-home-'))
  mkdirSync(join(workspace, 'src', 'auth'), { recursive: true })
  mkdirSync(join(workspace, 'src', 'api'), { recursive: true })
  mkdirSync(join(workspace, 'src', 'cache'), { recursive: true })
  writeFileSync(join(workspace, 'src', 'auth', 'session.ts'), `import { loadUser } from '../users/repository'\nexport class SessionManager {\n  validateCredentials(userId: string) { return loadUser(userId) }\n}\nconst internal = 'VERY_PRIVATE_LITERAL_DO_NOT_INDEX'\n`)
  writeFileSync(join(workspace, 'src', 'api', 'loginController.ts'), `import { SessionManager } from '../auth/session'\nexport function loginHandler(userId: string) { return new SessionManager().validateCredentials(userId) }\nexport class ApiSession extends SessionManager {}\n`)
  writeFileSync(join(workspace, 'src', 'cache', 'store.ts'), 'export function cacheValue() { return new Map() }\n')
  writeFileSync(join(workspace, '.env'), 'SECRET=never-index\n')
  return { workspace, home }
}

test('indeks incremental memakai ulang file, memperbarui yang berubah, dan tidak menyimpan literal source', async () => {
  const { workspace, home } = fixture()
  const first = await updateRepositoryIndex(workspace, home)
  assert.equal(first.updated, 3)
  assert.equal(first.reused, 0)
  assert.equal(first.persisted, true)
  const second = await updateRepositoryIndex(workspace, home)
  assert.equal(second.updated, 0)
  assert.equal(second.reused, 3)

  writeFileSync(join(workspace, 'src', 'cache', 'store.ts'), 'export function cacheValue() { return new WeakMap() }\n')
  const third = await updateRepositoryIndex(workspace, home)
  assert.equal(third.updated, 1)
  assert.equal(third.reused, 2)

  const roots = readdirSync(join(home, '.boo', 'indexes'))
  const path = join(home, '.boo', 'indexes', roots[0], 'repository-v2.json')
  const raw = readFileSync(path, 'utf8')
  assert.doesNotMatch(raw, /VERY_PRIVATE_LITERAL_DO_NOT_INDEX|never-index/)
  assert.doesNotMatch(raw, /\.env/)
  assert.equal(statSync(path).mode & 0o777, 0o600)
  assert.equal(statSync(join(home, '.boo', 'indexes', roots[0])).mode & 0o777, 0o700)
  assert.equal(third.index.files.find((file) => file.path.endsWith('session.ts'))?.parser, 'typescript-ast')
  assert.ok(third.index.files.find((file) => file.path.endsWith('session.ts'))?.calls.some((call) => call.name === 'loadUser'))
})

test('code_search meranking konsep, simbol, dependency, dan mengembalikan bukti baris terbaru', async () => {
  const { workspace, home } = fixture()
  const auth = await codeSearchTool.run({ query: 'authentication login', max_results: 5 }, { workspace, home })
  assert.equal(auth.isError, undefined)
  assert.match(auth.content, /src\/api\/loginController\.ts/)
  assert.match(auth.content, /src\/auth\/session\.ts/)
  assert.match(auth.content, /loginHandler@2|SessionManager@2/)
  assert.match(auth.content, /2: export (?:function loginHandler|class SessionManager)/)
  assert.match(auth.content, /indexed files; .*persisted/)

  const dependency = await codeSearchTool.run({ query: 'user repository', path: 'src/auth' }, { workspace, home })
  assert.match(dependency.content, /imports: \.\.\/users\/repository/)
  assert.doesNotMatch(dependency.content, /src\/cache/)

  const graph = await codeSearchTool.run({ query: 'validate credentials', max_results: 5 }, { workspace, home })
  assert.match(graph.content, /src\/auth\/session\.ts/)
  assert.match(graph.content, /src\/api\/loginController\.ts[\s\S]*related: src\/auth\/session\.ts/)
})

test('code_graph menampilkan definition, caller, callee, dan inheritance dari AST', async () => {
  const { workspace, home } = fixture()
  const method = await codeGraphTool.run({ symbol: 'SessionManager.validateCredentials' }, { workspace, home })
  assert.equal(method.isError, undefined)
  assert.match(method.content, /Definitions:[\s\S]*src\/auth\/session\.ts:3.*method SessionManager\.validateCredentials/)
  assert.match(method.content, /Callers:[\s\S]*src\/api\/loginController\.ts:2.*loginHandler/)
  assert.match(method.content, /Callees:[\s\S]*loadUser.*src\/auth\/session\.ts:3/)
  assert.match(method.content, /TypeScript\/JavaScript AST/)

  const base = await codeGraphTool.run({ symbol: 'SessionManager' }, { workspace, home })
  assert.match(base.content, /Inherited by:[\s\S]*src\/api\/loginController\.ts:3.*ApiSession/)
  assert.equal((await codeGraphTool.run({ symbol: '../invalid' }, { workspace, home })).isError, true)
})

test('symlink source keluar workspace dan file sensitif tidak masuk indeks', async () => {
  const { workspace, home } = fixture()
  const outside = mkdtempSync(join(tmpdir(), 'boo-code-search-outside-'))
  writeFileSync(join(outside, 'stolen.ts'), 'export const stolenCredential = "SECRET_FROM_OUTSIDE"\n')
  symlinkSync(join(outside, 'stolen.ts'), join(workspace, 'src', 'stolen.ts'))
  const update = await updateRepositoryIndex(workspace, home)
  assert.ok(!update.index.files.some((file) => file.path.includes('stolen') || file.path.includes('.env')))
  assert.equal((await codeSearchTool.run({ query: '', max_results: 2 }, { workspace, home })).isError, true)
  assert.equal((await codeSearchTool.run({ query: 'auth', path: '../outside' }, { workspace, home })).isError, true)
})
