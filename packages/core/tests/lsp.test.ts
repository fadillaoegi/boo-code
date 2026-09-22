import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { languageServerFor, lspTool, runLspQuery, type LspServerDefinition } from '../src/tools/lsp.ts'

const fakeServerPath = join(import.meta.dirname, 'fixtures', 'fake-lsp.mjs')

async function fixture(): Promise<{ workspace: string; server: LspServerDefinition }> {
  const workspace = await mkdtemp(join(tmpdir(), 'boo-lsp-'))
  await writeFile(join(workspace, 'app.ts'), 'class Worker {\n  run() {}\n  broken() {}\n}\n')
  return {
    workspace,
    server: { label: 'Fake LSP', languageId: 'typescript', command: `"${process.execPath}" "${fakeServerPath}"`, installHint: 'fake server tersedia' },
  }
}

test('adapter memilih language server sesuai ekstensi', () => {
  assert.equal(languageServerFor('/tmp/project', 'src/app.ts')?.label, 'TypeScript Language Server')
  assert.equal(languageServerFor('/tmp/project', 'main.py')?.languageId, 'python')
  assert.equal(languageServerFor('/tmp/project', 'main.go')?.command, 'gopls')
  assert.equal(languageServerFor('/tmp/project', 'lib.rs')?.command, 'rust-analyzer')
  assert.equal(languageServerFor('/tmp/project', 'image.png'), null)
})

test('LSP document symbols mempertahankan hierarki dan nomor baris', async () => {
  const { workspace, server } = await fixture()
  const result = await runLspQuery(workspace, { path: 'app.ts', action: 'document_symbols' }, { server, sandbox: { mode: 'danger-full-access' } })
  assert.match(result.content, /^1: class Worker/m)
  assert.match(result.content, /^ {2}2: method run/m)
})

test('LSP definition dan references dikembalikan sebagai path workspace', async () => {
  const { workspace, server } = await fixture()
  const definition = await runLspQuery(workspace, { path: 'app.ts', action: 'definition', line: 2, column: 3 }, { server, sandbox: { mode: 'danger-full-access' } })
  assert.equal(definition.content, 'app.ts:2:3')
  const references = await runLspQuery(workspace, { path: 'app.ts', action: 'references', line: 2, column: 3 }, { server, sandbox: { mode: 'danger-full-access' } })
  assert.equal(references.content, 'app.ts:2:3\napp.ts:4:8')
})

test('LSP hover mempertahankan markdown type information', async () => {
  const { workspace, server } = await fixture()
  const result = await runLspQuery(workspace, { path: 'app.ts', action: 'hover', line: 2, column: 3 }, { server, sandbox: { mode: 'danger-full-access' } })
  assert.match(result.content, /Worker\.run\(\): void/)
})

test('LSP diagnostics menandai severity error sebagai kegagalan tool', async () => {
  const { workspace, server } = await fixture()
  const query = await runLspQuery(workspace, { path: 'app.ts', action: 'diagnostics' }, { server, sandbox: { mode: 'danger-full-access' } })
  assert.equal(query.hasErrors, true)
  assert.match(query.content, /app\.ts:3:5: error FAKE1 \[fake-lsp\]: Contoh error semantic/)

  // Lapisan tool tetap menolak file rahasia sebelum server apa pun dijalankan.
  const refused = await lspTool.run({ path: '.env', action: 'hover', line: 1, column: 1 }, { workspace })
  assert.equal(refused.isError, true)
})

test('action berbasis posisi menolak line/column yang hilang', async () => {
  const { workspace, server } = await fixture()
  await assert.rejects(
    runLspQuery(workspace, { path: 'app.ts', action: 'definition' }, { server, sandbox: { mode: 'danger-full-access' } }),
    /line dan column/,
  )
})
