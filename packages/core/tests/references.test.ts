import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Agent } from '../src/agent/loop.ts'
import {
  expandPromptReferences,
  FILE_REFERENCE_MARK,
  MAX_PROMPT_REFERENCES,
  MAX_REFERENCE_FILE_BYTES,
  referencedPromptTitle,
} from '../src/agent/references.ts'
import type { Message } from '../src/domain/message.ts'
import { buildTranscript } from '../src/presentation/transcript.ts'
import type { NineRouterProvider } from '../src/provider/nineRouter.ts'
import { createRegistry } from '../src/domain/tool.ts'
import { PROMPT_COMMAND_MARK, promptCommandTitle } from '../src/agent/commands.ts'
import { planPromptTitle, planRequest } from '../src/agent/planning.ts'

function workspace(): string {
  return mkdtempSync(join(tmpdir(), 'boo-references-'))
}

test('@file, rentang baris, path berspasi, dan folder menjadi konteks bernomor', () => {
  const root = workspace()
  mkdirSync(join(root, 'src'))
  mkdirSync(join(root, 'folder data'))
  writeFileSync(join(root, 'src', 'app.ts'), 'satu\ndua\ntiga\nempat\n')
  writeFileSync(join(root, 'folder data', 'catatan.md'), '# Catatan\n')

  const input = 'Bandingkan @src/app.ts:2-3 dengan @"folder data" lalu jelaskan.'
  const result = expandPromptReferences(input, root)
  assert.equal(result.expanded, true)
  assert.equal(referencedPromptTitle(result.prompt), input)
  assert.deepEqual(result.references.map((item) => [item.path, item.kind]), [
    ['src/app.ts', 'file'], ['folder data', 'directory'],
  ])
  assert.match(result.prompt, /2\tdua/)
  assert.match(result.prompt, /3\ttiga/)
  assert.doesNotMatch(result.prompt, /1\tsatu/)
  assert.match(result.prompt, /@folder data \(direktori\)/)
  assert.match(result.prompt, /catatan\.md/)
  assert.match(result.prompt, /data tidak tepercaya/)
  assert.match(result.untrustedText, /2\tdua/)
  assert.doesNotMatch(result.untrustedText, /# Permintaan pengguna/)
})

test('email dan fenced code diabaikan, referensi duplikat hanya dimuat sekali', () => {
  const root = workspace()
  writeFileSync(join(root, 'a.ts'), 'export const a = 1\n')
  const result = expandPromptReferences('Hubungi dev@example.com dan baca @a.ts lagi @a.ts.\n```\ncontoh @missing.ts\n```', root)
  assert.equal(result.references.length, 1)
  assert.equal(result.references[0].path, 'a.ts')
  assert.doesNotMatch(result.prompt, /missing\.ts: tidak ditemukan/)
  assert.doesNotMatch(result.prompt, /dev@example.*tidak ditemukan/)
})

test('secret dan symlink keluar workspace tidak pernah masuk konteks', () => {
  const root = workspace()
  const outside = workspace()
  writeFileSync(join(root, '.env'), 'TOKEN=SANGAT_RAHASIA\n')
  writeFileSync(join(outside, 'outside.ts'), 'const rahasiaLuar = true\n')
  symlinkSync(join(outside, 'outside.ts'), join(root, 'outside.ts'))
  mkdirSync(join(root, 'folder'))
  symlinkSync(outside, join(root, 'folder', 'nested-outside'))

  const result = expandPromptReferences('Periksa @.env, @outside.ts, dan @folder', root)
  assert.equal(result.references.length, 1)
  assert.match(result.prompt, /ditolak karena tampak memuat kredensial/)
  assert.match(result.prompt, /keluar dari workspace melalui symlink/)
  assert.match(result.prompt, /nested-outside \[symlink dilewati\]/)
  assert.doesNotMatch(result.prompt, /SANGAT_RAHASIA|rahasiaLuar/)
})

test('file besar dan jumlah referensi dibatasi tanpa membaca semuanya', () => {
  const root = workspace()
  writeFileSync(join(root, 'besar.txt'), 'x'.repeat(MAX_REFERENCE_FILE_BYTES + 10_000))
  for (let index = 1; index <= MAX_PROMPT_REFERENCES; index += 1) writeFileSync(join(root, `f${index}.txt`), `${index}\n`)
  const input = `Baca @besar.txt ${Array.from({ length: MAX_PROMPT_REFERENCES }, (_, index) => `@f${index + 1}.txt`).join(' ')}`
  const result = expandPromptReferences(input, root)
  assert.equal(result.references.length, MAX_PROMPT_REFERENCES)
  assert.equal(result.references[0].truncated, true)
  assert.match(result.issues.join('\n'), /konteks dipotong/)
  assert.match(result.issues.join('\n'), /Batas referensi/)
  assert.ok(result.prompt.length < MAX_REFERENCE_FILE_BYTES + 20_000)
})

test('agent mengirim konteks referensi ke provider tetapi transcript menampilkan prompt asli', async () => {
  const root = workspace()
  writeFileSync(join(root, 'config.ts'), 'export const port = 4321\n')
  const seen: Message[][] = []
  const provider = {
    model: 'palsu',
    stream(messages: Message[]) {
      seen.push(messages.map((message) => ({ ...message })))
      return (async function* reply() {
        yield { type: 'text' as const, delta: 'Portnya 4321.' }
        return { finishReason: 'stop', message: { role: 'assistant' as const, content: 'Portnya 4321.' } }
      })()
    },
  } as unknown as NineRouterProvider
  const agent = new Agent({ provider, workspace: root, registry: createRegistry([]), askPermission: async () => true })
  for await (const event of agent.send('Berapa port di @config.ts?')) void event

  const sent = seen[0].find((message) => message.role === 'user')?.content ?? ''
  assert.ok(sent.startsWith(FILE_REFERENCE_MARK))
  assert.match(sent, /port = 4321/)
  assert.equal(buildTranscript(agent.history).flat().find((item) => item.kind === 'user')?.text, 'Berapa port di @config.ts?')
})

test('marker custom command dan plan tetap dikenali setelah konteks @path dibungkus', () => {
  const root = workspace()
  writeFileSync(join(root, 'a.ts'), 'const a = true\n')
  const command = `${PROMPT_COMMAND_MARK}\n${JSON.stringify('/audit @a.ts')}\n\nAudit @a.ts`
  assert.equal(promptCommandTitle(expandPromptReferences(command, root).prompt), '/audit @a.ts')
  assert.equal(planPromptTitle(expandPromptReferences(planRequest('Audit @a.ts'), root).prompt), 'Audit @a.ts')
})
