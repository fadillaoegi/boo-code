import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { analyzeChangeImpact, changeImpactTool } from '../src/tools/changeImpact.ts'

function fixture() {
  const workspace = mkdtempSync(join(tmpdir(), 'boo-change-impact-'))
  const home = mkdtempSync(join(tmpdir(), 'boo-change-impact-home-'))
  mkdirSync(join(workspace, 'src'), { recursive: true })
  mkdirSync(join(workspace, 'tests'), { recursive: true })
  writeFileSync(join(workspace, 'src', 'core.ts'), 'export function core() { return 1 }\n')
  writeFileSync(join(workspace, 'src', 'service.ts'), "import { core } from './core'\nexport function service() { return core() }\n")
  writeFileSync(join(workspace, 'src', 'controller.ts'), "import { service } from './service'\nexport function controller() { return service() }\n")
  writeFileSync(join(workspace, 'src', 'core.test.ts'), "import { core } from './core'\nvoid core()\n")
  writeFileSync(join(workspace, 'tests', 'controller.spec.ts'), "import { controller } from '../src/controller'\nvoid controller()\n")
  writeFileSync(join(workspace, 'src', 'base.ts'), 'export class BaseRunner { run() { return true } }\n')
  writeFileSync(join(workspace, 'src', 'child.ts'), "import { BaseRunner } from './base'\nexport class ChildRunner extends BaseRunner {}\n")
  return { workspace, home }
}

test('graph dampak menelusuri importer, caller, test, simbol, dan depth secara deterministik', async () => {
  const { workspace, home } = fixture()
  const graph = await analyzeChangeImpact(workspace, ['src/core.ts'], home)

  assert.ok(graph.affectedSymbols.some((symbol) => symbol.path === 'src/core.ts' && symbol.name === 'core'))
  assert.equal(graph.affectedFiles.find((file) => file.path === 'src/service.ts')?.depth, 1)
  assert.equal(graph.affectedFiles.find((file) => file.path === 'src/controller.ts')?.depth, 2)
  assert.equal(graph.affectedFiles.find((file) => file.path === 'tests/controller.spec.ts')?.depth, 3)
  assert.deepEqual(graph.directTests, ['src/core.test.ts'])
  assert.deepEqual(graph.dependentTests, ['tests/controller.spec.ts'])
  assert.ok(graph.edges.some((edge) => edge.from === 'src/core.ts' && edge.to === 'src/service.ts' && edge.relation === 'imported-by' && edge.confidence === 'high'))
  assert.ok(graph.edges.some((edge) => edge.from === 'src/core.ts' && edge.to === 'src/service.ts' && edge.relation === 'called-by'))
  assert.equal(graph.blastRadius, 'medium')
  assert.equal(graph.truncated, false)
})

test('depth membatasi propagasi dan inheritance menjadi relasi graph', async () => {
  const { workspace, home } = fixture()
  const shallow = await analyzeChangeImpact(workspace, ['src/core.ts'], home, undefined, 1)
  assert.ok(shallow.affectedFiles.some((file) => file.path === 'src/service.ts'))
  assert.ok(!shallow.affectedFiles.some((file) => file.path === 'src/controller.ts'))

  const inheritance = await analyzeChangeImpact(workspace, ['src/base.ts'], home)
  assert.ok(inheritance.edges.some((edge) => edge.from === 'src/base.ts' && edge.to === 'src/child.ts' && edge.relation === 'inherited-by'))
  assert.ok(inheritance.affectedFiles.find((file) => file.path === 'src/child.ts')?.relations.includes('inherited-by'))
})

test('tool change_impact aman, menolak traversal, dan melaporkan blast radius tanpa menjalankan code', async () => {
  const { workspace, home } = fixture()
  assert.equal(changeImpactTool.risk, 'safe')
  assert.equal(changeImpactTool.runsCommand, undefined)
  assert.equal((await changeImpactTool.run({ changed_files: ['../outside.ts'] }, { workspace, home })).isError, true)

  const result = await changeImpactTool.run({ changed_files: ['src/core.ts'], max_depth: 3 }, { workspace, home })
  assert.equal(result.isError, undefined)
  assert.match(result.content, /Change impact graph · blast radius medium/)
  assert.match(result.content, /Konsumen langsung: .*src\/service\.ts/)
  assert.match(result.content, /Konsumen transitif: .*src\/controller\.ts/)
  assert.match(result.content, /Test terdampak: src\/core\.test\.ts, tests\/controller\.spec\.ts/)
  assert.match(result.content, /node · .* edge · depth ≤ 3/)
})
