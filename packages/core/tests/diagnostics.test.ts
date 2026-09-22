import assert from 'node:assert/strict'
import test from 'node:test'
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectProjectDiagnostics, diagnosticsTool } from '../src/tools/diagnostics.ts'

async function workspace(scripts: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'boo-diagnostics-'))
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts }))
  return root
}

test('deteksi memakai package manager dan script yang benar-benar dikonfigurasi', async () => {
  const root = await workspace({ typecheck: 'tsc -b', lint: 'eslint .' })
  await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  assert.deepEqual(await detectProjectDiagnostics(root), [
    { kind: 'types', label: 'Type diagnostics (typecheck)', command: 'pnpm run typecheck' },
    { kind: 'lint', label: 'Lint diagnostics', command: 'pnpm run lint' },
  ])
  assert.deepEqual(await detectProjectDiagnostics(root, 'lint'), [
    { kind: 'lint', label: 'Lint diagnostics', command: 'pnpm run lint' },
  ])
})

test('deteksi lintas bahasa tidak bergantung pada package.json', async () => {
  const root = await mkdtemp(join(tmpdir(), 'boo-diagnostics-multi-'))
  await writeFile(join(root, 'go.mod'), 'module example.invalid/app\n')
  await writeFile(join(root, 'Cargo.toml'), '[package]\nname="app"\nversion="0.1.0"\n')
  await writeFile(join(root, 'pubspec.yaml'), 'name: app\ndependencies:\n  flutter:\n    sdk: flutter\n')
  const found = await detectProjectDiagnostics(root, 'types')
  assert.deepEqual(found.map((entry) => entry.command), [
    'go vet ./...',
    'cargo check --all-targets --message-format short',
    'flutter analyze --no-pub',
  ])
})

test('pyproject hanya menawarkan ruff bila executable lokal tersedia', async () => {
  const root = await mkdtemp(join(tmpdir(), 'boo-diagnostics-python-'))
  await writeFile(join(root, 'pyproject.toml'), '[tool.ruff]\nline-length = 100\n')
  assert.deepEqual(await detectProjectDiagnostics(root, 'lint'), [])
  const binary = join(root, '.venv', 'bin', 'ruff')
  await mkdir(join(root, '.venv', 'bin'), { recursive: true })
  await writeFile(binary, '#!/bin/sh\nexit 0\n')
  await chmod(binary, 0o755)
  assert.equal((await detectProjectDiagnostics(root, 'lint'))[0]?.command, './.venv/bin/ruff check .')
})

test('diagnostics menjalankan check terdeteksi dan melaporkan bukti command', async () => {
  const root = await workspace({ typecheck: 'node -e "console.log(\'types ok\')"' })
  const result = await diagnosticsTool.run({ kind: 'types', timeout: 10 }, {
    workspace: root,
    sandbox: { mode: 'danger-full-access' },
  })
  assert.equal(result.isError, undefined)
  assert.match(result.content, /npm run typecheck/)
  assert.match(result.content, /types ok/)
  assert.match(result.content, /\[exit 0\]/)
})

test('diagnostics gagal jelas bila tidak ada konfigurasi yang didukung', async () => {
  const root = await mkdtemp(join(tmpdir(), 'boo-diagnostics-empty-'))
  const result = await diagnosticsTool.run({}, { workspace: root })
  assert.equal(result.isError, true)
  assert.match(result.content, /tidak menemukan/)
})
