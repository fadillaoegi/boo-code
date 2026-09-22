import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  analyzeVerificationImpact,
  conventionalTestCandidates,
  detectProjectTestCommands,
  isTestPath,
  testImpactTool,
} from '../src/tools/testImpact.ts'

function typescriptFixture() {
  const workspace = mkdtempSync(join(tmpdir(), 'boo-test-impact-'))
  const home = mkdtempSync(join(tmpdir(), 'boo-test-impact-home-'))
  mkdirSync(join(workspace, 'src'), { recursive: true })
  mkdirSync(join(workspace, 'tests'), { recursive: true })
  writeFileSync(join(workspace, 'src', 'core.ts'), 'export const core = 1\n')
  writeFileSync(join(workspace, 'src', 'core.test.ts'), "import { core } from './core'\nvoid core\n")
  writeFileSync(join(workspace, 'src', 'service.ts'), "import { core } from './core'\nexport const service = core\n")
  writeFileSync(join(workspace, 'tests', 'service.spec.ts'), "import { service } from '../src/service'\nvoid service\n")
  writeFileSync(join(workspace, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }))
  writeFileSync(join(workspace, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  return { workspace, home }
}

test('impact menemukan test langsung dan test reverse-dependency tanpa menjalankannya', async () => {
  const { workspace, home } = typescriptFixture()
  const impact = await analyzeVerificationImpact(workspace, ['src/core.ts'], home)

  assert.deepEqual(impact.directTests, ['src/core.test.ts'])
  assert.deepEqual(impact.dependentTests, ['tests/service.spec.ts'])
  assert.deepEqual(impact.commands, [{ label: 'Project test (test)', command: 'pnpm run test', source: 'package.json' }])
  assert.equal(impact.indexedFiles, 5)
})

test('konvensi test lintas bahasa dipetakan deterministik', () => {
  assert.ok(conventionalTestCandidates('lib/cart.dart').includes('test/cart_test.dart'))
  assert.ok(conventionalTestCandidates('src/account/user.py').includes('tests/account/test_user.py'))
  assert.ok(conventionalTestCandidates('api/order.go').includes('api/order_test.go'))
  assert.ok(conventionalTestCandidates('src/main/java/Cart.java').includes('src/test/java/CartTest.java'))
  assert.equal(isTestPath('tests/unit/cart.spec.ts'), true)
  assert.equal(isTestPath('src/cart.ts'), false)
})

test('command native hanya muncul saat manifest atau config terkait ada', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'boo-test-command-'))
  writeFileSync(join(workspace, 'go.mod'), 'module example.com/demo\n')
  writeFileSync(join(workspace, 'pyproject.toml'), '[tool.pytest.ini_options]\naddopts = "-q"\n')
  const commands = await detectProjectTestCommands(workspace, ['pkg/cart.go'], ['tests/test_cart.py'])
  assert.deepEqual(commands.map((entry) => entry.command), ['go test ./pkg', 'python -m pytest tests/test_cart.py'])

  const empty = mkdtempSync(join(tmpdir(), 'boo-test-command-empty-'))
  assert.deepEqual(await detectProjectTestCommands(empty, ['src/cart.ts'], ['src/cart.test.ts']), [])
})

test('tool test_impact aman, memvalidasi input, dan memberi sumber command', async () => {
  const { workspace, home } = typescriptFixture()
  assert.equal(testImpactTool.risk, 'safe')
  assert.equal(testImpactTool.runsCommand, undefined)
  assert.equal((await testImpactTool.run({ changed_files: [] }, { workspace, home })).isError, true)

  const result = await testImpactTool.run({ changed_files: ['src/core.ts'] }, { workspace, home })
  assert.equal(result.isError, undefined)
  assert.match(result.content, /Test langsung: src\/core\.test\.ts/)
  assert.match(result.content, /Test via dependency: tests\/service\.spec\.ts/)
  assert.match(result.content, /pnpm run test \[package\.json\]/)
})
