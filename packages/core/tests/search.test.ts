import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { globTool } from '../src/tools/glob.ts'
import { grepTool } from '../src/tools/grep.ts'

/** Workspace berisi kode, dependensi, rahasia, dan berkas biner. */
async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'boo-cari-'))
  const files: Record<string, string> = {
    'src/app.ts': 'import { useChat } from "./chat"\nexport function App() {\n  return useChat()\n}\n',
    'src/lib/util.ts': 'export const PI = 3.14\n',
    'src/chat.ts': 'export function useChat() {\n  return "halo"\n}\n',
    'docs/panduan.md': '# Panduan\npakai UseChat di komponen\n',
    'node_modules/pustaka/index.ts': 'export function useChat() {}\n',
    'dist/app.js': 'function useChat(){}\n',
    '.env': 'API_KEY=sk-rahasia-useChat-12345\n',
  }
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true })
    await writeFile(join(root, path), content, 'utf8')
  }
  await writeFile(join(root, 'src/gambar.png'), Buffer.from([0x89, 0x50, 0x00, 0x00, 0x75, 0x73, 0x65, 0x43, 0x68, 0x61, 0x74]))
  return root
}

const lines = (content: string) => content.split('\n').filter(Boolean)

test('glob menemukan berkas sesuai pola dan melewati dependensi serta hasil build', async () => {
  const root = await workspace()
  const { content } = await globTool.run({ pattern: '**/*.ts' }, { workspace: root })
  assert.deepEqual(lines(content).sort(), ['src/app.ts', 'src/chat.ts', 'src/lib/util.ts'])
})

test('glob mengurutkan berkas yang terakhir diubah lebih dulu', async () => {
  const root = await workspace()
  const past = new Date(Date.now() - 3_600_000)
  await utimes(join(root, 'src/app.ts'), past, past)
  await utimes(join(root, 'src/lib/util.ts'), past, past)
  const { content } = await globTool.run({ pattern: 'src/**/*.ts' }, { workspace: root })
  assert.equal(lines(content)[0], 'src/chat.ts')
})

test('glob tidak dapat keluar dari workspace lewat .. maupun path absolut', async () => {
  const root = await workspace()
  const outside = join(root, '..', `luar-${Date.now()}.ts`)
  await writeFile(outside, 'rahasia di luar', 'utf8')
  for (const pattern of ['../*.ts', '../**/*.ts', `${join(root, '..')}/*.ts`]) {
    const { content } = await globTool.run({ pattern }, { workspace: root })
    assert.doesNotMatch(content, /luar-/, `pola ${pattern} menembus workspace`)
  }
  await assert.rejects(globTool.run({ pattern: '*', path: '..' }, { workspace: root }))
})

test('glob menandai berkas rahasia tanpa membacanya', async () => {
  const root = await workspace()
  const { content } = await globTool.run({ pattern: '.env*' }, { workspace: root })
  assert.match(content, /\.env {2}\[rahasia, tidak dapat dibaca\]/)
})

test('grep mengembalikan path, nomor baris, dan isi baris', async () => {
  const root = await workspace()
  const { content } = await grepTool.run({ pattern: 'useChat' }, { workspace: root })
  assert.ok(lines(content).includes('src/app.ts:3:   return useChat()'), content)
  assert.ok(lines(content).includes('src/chat.ts:1: export function useChat() {'))
  assert.doesNotMatch(content, /node_modules|dist\//, 'dependensi dan hasil build dilewati')
})

test('grep tidak pernah membocorkan isi berkas rahasia, termasuk bila disasar langsung', async () => {
  const root = await workspace()
  // Pencarian umum: dotfile tidak ditelusuri, sama seperti ripgrep.
  const broad = await grepTool.run({ pattern: 'useChat|API_KEY' }, { workspace: root })
  assert.doesNotMatch(broad.content, /sk-rahasia/)

  // Disasar lewat pola berkas: ditemukan, tetapi isinya dilewati.
  const byInclude = await grepTool.run({ pattern: 'API_KEY', include: '.env*' }, { workspace: root })
  assert.doesNotMatch(byInclude.content, /sk-rahasia/)
  assert.match(byInclude.content, /1 berkas rahasia dilewati/)

  // Disasar lewat path berkas.
  const byPath = await grepTool.run({ pattern: 'API_KEY', path: '.env' }, { workspace: root })
  assert.doesNotMatch(byPath.content, /sk-rahasia/)
  assert.match(byPath.content, /1 berkas rahasia dilewati/)
})

test('grep melewati berkas biner', async () => {
  const root = await workspace()
  const { content } = await grepTool.run({ pattern: 'useChat' }, { workspace: root })
  assert.doesNotMatch(content, /gambar\.png/)
})

test('regex tidak valid dikembalikan sebagai hasil gagal, bukan exception', async () => {
  const root = await workspace()
  const result = await grepTool.run({ pattern: 'use(Chat' }, { workspace: root })
  assert.equal(result.isError, true)
  assert.match(result.content, /regex tidak valid/)
})

test('grep dapat dibatasi pola berkas, tanpa huruf besar-kecil, dan hanya nama berkas', async () => {
  const root = await workspace()
  const onlyMd = await grepTool.run({ pattern: 'usechat', include: '**/*.md', ignore_case: true }, { workspace: root })
  assert.deepEqual(lines(onlyMd.content), ['docs/panduan.md:2: pakai UseChat di komponen'])

  const counts = await grepTool.run({ pattern: 'useChat', files_only: true }, { workspace: root })
  assert.deepEqual(lines(counts.content).filter((line) => !line.startsWith('(')), ['src/app.ts (2)', 'src/chat.ts (1)'])
})

test('grep pada satu berkas', async () => {
  const root = await workspace()
  const { content } = await grepTool.run({ pattern: 'return', path: 'src/chat.ts' }, { workspace: root })
  assert.deepEqual(lines(content), ['src/chat.ts:2:   return "halo"'])
})

test('hasil grep yang terlalu banyak dibatasi dengan keterangan', async () => {
  const root = await workspace()
  await writeFile(join(root, 'src/banyak.ts'), Array.from({ length: 500 }, (_, i) => `const x${i} = 1`).join('\n'), 'utf8')
  const { content } = await grepTool.run({ pattern: 'const x' }, { workspace: root })
  assert.equal(lines(content).filter((line) => line.startsWith('src/')).length, 200)
  assert.match(content, /hasil dibatasi 200 baris/)
})

test('grep tidak dapat menelusuri di luar workspace', async () => {
  const root = await workspace()
  await assert.rejects(grepTool.run({ pattern: 'x', path: '../' }, { workspace: root }))
})
