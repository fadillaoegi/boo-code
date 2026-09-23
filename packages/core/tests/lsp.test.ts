import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Agent, type AgentEvent } from '../src/agent/loop.ts'
import type { Message } from '../src/domain/message.ts'
import { createRegistry, type Tool } from '../src/domain/tool.ts'
import type { NineRouterProvider } from '../src/provider/nineRouter.ts'
import { closeLspSessions, languageServerFor, lspSessionSnapshot, lspTool, runLspQuery, type LspServerDefinition } from '../src/tools/lsp.ts'

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

test('session LSP dipakai ulang dan file berubah dikirim sebagai didChange', async () => {
  await closeLspSessions()
  const { workspace, server } = await fixture()
  const first = await runLspQuery(workspace, { path: 'app.ts', action: 'hover', line: 2, column: 3 }, { server, sandbox: { mode: 'danger-full-access' } })
  assert.deepEqual(first.session, { reused: false, restarted: false, openDocuments: 1 })
  assert.match(first.content, /version=1/)

  await writeFile(join(workspace, 'app.ts'), 'class Worker {\n  run() { return 1 }\n}\n')
  const second = await runLspQuery(workspace, { path: 'app.ts', action: 'hover', line: 2, column: 3 }, { server, sandbox: { mode: 'danger-full-access' } })
  assert.deepEqual(second.session, { reused: true, restarted: false, openDocuments: 1 })
  assert.match(second.content, /version=2/)
  assert.deepEqual(lspSessionSnapshot(), { sessions: 1, openDocuments: 1 })
  await closeLspSessions()
})

test('session LSP yang crash dipulihkan sekali dan dokumen dibuka ulang', async () => {
  await closeLspSessions()
  const { workspace, server } = await fixture()
  await runLspQuery(workspace, { path: 'app.ts', action: 'document_symbols' }, { server, sandbox: { mode: 'danger-full-access' } })
  await writeFile(join(workspace, 'app.ts'), 'class Worker {\n  CRASH_ON_CHANGE = true\n}\n')
  const recovered = await runLspQuery(workspace, { path: 'app.ts', action: 'hover', line: 2, column: 3 }, { server, sandbox: { mode: 'danger-full-access' } })
  assert.equal(recovered.session.restarted, true)
  assert.equal(recovered.session.reused, false)
  assert.equal(recovered.session.openDocuments, 1)
  assert.match(recovered.content, /version=1/)
  await closeLspSessions()
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

test('agent meneruskan lifecycle session LSP sebagai event tanpa path atau source', async () => {
  const { workspace } = await fixture()
  const tool: Tool<Record<string, never>> = {
    name: 'fake_lsp', description: 'fake lsp lifecycle', risk: 'safe',
    schema: { type: 'function', function: { name: 'fake_lsp', description: 'fake', parameters: { type: 'object', properties: {} } } },
    preview: () => 'fake lsp',
    async run() { return { content: 'semantic result', lspSession: { reused: true, restarted: false, openDocuments: 2 } } },
  }
  let turn = 0
  const provider = {
    model: 'fake-model',
    stream() {
      turn += 1
      const message: Message = turn === 1
        ? { role: 'assistant', content: null, tool_calls: [{ id: 'lsp-1', type: 'function', function: { name: 'fake_lsp', arguments: '{}' } }] }
        : { role: 'assistant', content: 'selesai' }
      // eslint-disable-next-line require-yield
      return (async function* reply() { return { finishReason: turn === 1 ? 'tool_calls' : 'stop', message } })()
    },
  } as unknown as NineRouterProvider
  const agent = new Agent({ provider, registry: createRegistry([tool]), workspace, askPermission: async () => true, verifyCompletion: false, autoReview: false })
  const events: AgentEvent[] = []
  for await (const event of agent.send('cek semantic')) events.push(event)
  const lifecycle = events.find((event) => event.type === 'lsp-session')
  assert.deepEqual(lifecycle, { type: 'lsp-session', stage: 'reused', openDocuments: 2 })
  assert.equal(lifecycle && 'path' in lifecycle, false)
})
