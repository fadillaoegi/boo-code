import assert from 'node:assert/strict'
import test from 'node:test'
import { countLines, describeArgs, lastOutputLine, ToolCallProgress, toolActivity, turnActivity } from '../src/presentation/activity.ts'

/** Mengalirkan argumen JSON potong demi potong, seperti dari provider. */
function stream(name: string, args: object, size: number): ToolCallProgress {
  const progress = new ToolCallProgress(name)
  const json = JSON.stringify(args)
  for (let index = 0; index < json.length; index += size) progress.add(json.slice(index, index + size))
  return progress
}

test('setiap tool dipetakan ke aktivitas yang sesungguhnya', () => {
  assert.equal(toolActivity('tool_search'), 'Searching')
  assert.equal(toolActivity('list_dir'), 'Searching')
  assert.equal(toolActivity('read_file'), 'Reading')
  assert.equal(toolActivity('git_status'), 'Checking')
  assert.equal(toolActivity('git_changed_files'), 'Checking')
  assert.equal(toolActivity('git_diff'), 'Reading')
  assert.equal(toolActivity('git_log'), 'Searching')
  assert.equal(toolActivity('git_show'), 'Reading')
  assert.equal(toolActivity('git_blame'), 'Reading')
  assert.equal(toolActivity('git_commit'), 'Writing')
  assert.equal(toolActivity('write_file'), 'Writing')
  assert.equal(toolActivity('edit_file'), 'Implementing')
  assert.equal(toolActivity('apply_patch'), 'Implementing')
  assert.equal(toolActivity('bash'), 'Running')
})

test('putaran awal berpikir, putaran setelah tool mengorkestrasi', () => {
  assert.equal(turnActivity(0), 'Thinking')
  assert.equal(turnActivity(1), 'Orchestrating')
  assert.equal(turnActivity(5), 'Orchestrating')
})

test('path ditemukan walau terbelah di antara potongan', () => {
  const progress = stream('write_file', { path: 'src/komponen/tombol.tsx', content: 'a' }, 3)
  assert.equal(progress.path, 'src/komponen/tombol.tsx')
})

test('path dengan karakter ter-escape dipulihkan', () => {
  const progress = stream('read_file', { path: 'folder "khusus"/berkas.ts' }, 2)
  assert.equal(progress.path, 'folder "khusus"/berkas.ts')
})

test('baris isi dihitung walau penanda baris baru terbelah di antara potongan', () => {
  const content = `${Array.from({ length: 42 }, (_, i) => `baris ${i}`).join('\n')}\n`
  for (const size of [1, 2, 5, 17, 1000]) {
    const progress = stream('write_file', { path: 'a.ts', content }, size)
    assert.equal(progress.lines, 42, `potongan ${size} karakter`)
  }
})

test('garis miring terbalik literal tidak dihitung sebagai baris baru', () => {
  const progress = stream('write_file', { path: 'a.ts', content: 'C:\\new\\name' }, 1)
  assert.equal(progress.lines, 0)
})

test('keterangan write_file memuat jumlah baris, tool lain cukup path', () => {
  assert.equal(stream('write_file', { path: 'a.ts', content: 'x\ny\n' }, 4).describe(), 'a.ts · 2 lines')
  assert.equal(stream('write_file', { path: 'a.ts', content: 'x\n' }, 4).describe(), 'a.ts · 1 line')
  // Sebelum satu baris pun selesai, cukup path.
  assert.equal(stream('write_file', { path: 'a.ts', content: 'x' }, 4).describe(), 'a.ts')
  assert.equal(stream('edit_file', { path: 'b.ts', old_text: 'a\nb', new_text: 'c' }, 4).describe(), 'b.ts')
})

test('belum ada keterangan sebelum path diketahui', () => {
  const progress = new ToolCallProgress('write_file')
  progress.add('{"pa')
  assert.equal(progress.describe(), '')
})

test('keterangan dari argumen utuh sama bentuknya dengan saat mengalir', () => {
  // Berkas diakhiri baris baru: hitungan saat mengalir berakhir sama dengan hitungan final.
  const args = { path: 'a.ts', content: 'x\ny\nz\n' }
  assert.equal(describeArgs('write_file', args), stream('write_file', args, 3).describe())
  assert.equal(describeArgs('read_file', { path: 'src/app.ts' }), 'src/app.ts')
  assert.equal(describeArgs('list_dir', {}), '.')
  assert.equal(describeArgs('bash', { command: 'pnpm test' }), 'pnpm test')
  assert.equal(describeArgs('tool_search', { query: 'git history' }), '“git history”')
  assert.equal(describeArgs('git_show', { ref: 'HEAD', path: 'src/app.ts' }), 'src/app.ts')
})

test('baris baru di akhir berkas tidak menambah hitungan baris', () => {
  const thirty = `${Array.from({ length: 30 }, (_, i) => `${i + 1}. poin`).join('\n')}\n`
  assert.equal(countLines(thirty), 30)
  assert.equal(countLines('a\nb'), 2)
  assert.equal(countLines('satu'), 1)
  assert.equal(countLines(''), 0)
  assert.equal(describeArgs('write_file', { path: 'ringkasan.md', content: thirty }), 'ringkasan.md · 30 lines')
})

test('pencarian ditampilkan sebagai Searching dengan polanya', () => {
  assert.equal(toolActivity('grep'), 'Searching')
  assert.equal(toolActivity('glob'), 'Searching')
  assert.equal(toolActivity('repo_map'), 'Searching')
  assert.equal(toolActivity('web_search'), 'Searching')
  assert.equal(toolActivity('web_fetch'), 'Reading')
  assert.equal(toolActivity('browser_status'), 'Checking')
  assert.equal(toolActivity('browser_tabs'), 'Reading')
  assert.equal(toolActivity('browser_snapshot'), 'Reading')
  assert.equal(toolActivity('browser_diagnostics'), 'Checking')
  assert.equal(toolActivity('browser_click'), 'Running')
  assert.equal(toolActivity('browser_type'), 'Running')
  assert.equal(toolActivity('browser_navigate'), 'Running')
  assert.equal(toolActivity('browser_select'), 'Running')
  assert.equal(toolActivity('browser_press'), 'Running')
  assert.equal(toolActivity('diagnostics'), 'Checking')
  assert.equal(toolActivity('lsp'), 'Checking')
  assert.equal(toolActivity('list_skills'), 'Searching')
  assert.equal(toolActivity('read_skill'), 'Reading')
  assert.equal(toolActivity('list_mcp_servers'), 'Searching')
  assert.equal(toolActivity('mcp_list_tools'), 'Checking')
  assert.equal(toolActivity('mcp_call'), 'Running')
  assert.equal(toolActivity('delegate'), 'Orchestrating')
  assert.equal(toolActivity('delegate_write'), 'Orchestrating')
  assert.equal(toolActivity('code_search'), 'Searching')
  assert.equal(toolActivity('test_impact'), 'Checking')
  assert.equal(toolActivity('change_impact'), 'Checking')
  assert.equal(toolActivity('memory_list'), 'Reading')
  assert.equal(toolActivity('memory_add'), 'Writing')
  assert.equal(toolActivity('memory_remove'), 'Writing')
  assert.equal(toolActivity('ask_user'), 'Waiting')
  assert.equal(describeArgs('ask_user', { questions: [{ question: 'Pilih?' }] }), '1 question')
  assert.equal(describeArgs('grep', { pattern: 'useChat', path: 'src' }), '"useChat" in src')
  assert.equal(describeArgs('glob', { pattern: '**/*.ts' }), '**/*.ts')
  assert.equal(describeArgs('repo_map', { query: 'model router', path: 'src' }), '"model router" in src')
  assert.equal(describeArgs('web_search', { query: 'Node.js release terbaru' }), '“Node.js release terbaru”')
  assert.equal(describeArgs('web_fetch', { url: 'https://nodejs.org/' }), 'https://nodejs.org/')
  assert.equal(describeArgs('browser_open', { url: 'https://example.com/' }), 'https://example.com/')
  assert.equal(describeArgs('browser_snapshot', { tab_id: 'tab-one' }), 'tab-one')
  assert.equal(describeArgs('browser_click', { tab_id: 'tab-one', ref: 'e1', description: 'Tombol Simpan' }), 'Tombol Simpan')
  assert.equal(describeArgs('mcp_list_tools', { server: 'database' }), 'database')
  assert.equal(describeArgs('mcp_call', { server: 'database', tool: 'query' }), 'database/query')
  assert.equal(describeArgs('delegate', { tasks: [{ id: 'api', task: 'Inspect API' }, { id: 'ui', task: 'Inspect UI' }] }), '2 read-only tasks')
  assert.equal(describeArgs('delegate_write', { tasks: [{ id: 'api', task: 'Implement API' }, { id: 'ui', task: 'Implement UI' }] }), '2 isolated implementation tasks')
  assert.equal(describeArgs('code_search', { query: 'authentication flow', path: 'src' }), '"authentication flow" in src')
  assert.equal(describeArgs('test_impact', { changed_files: ['src/a.ts', 'src/b.ts'] }), '2 changed files')
  assert.equal(describeArgs('change_impact', { changed_files: ['src/a.ts'] }), '1 changed file')
  assert.equal(describeArgs('memory_add', { text: 'Gunakan pnpm test' }), 'Gunakan pnpm test')
  assert.equal(describeArgs('memory_remove', { id: 'deadbeef' }), 'deadbeef')
  assert.equal(describeArgs('git_commit', { message: 'feat: aman', paths: ['a.ts'] }), 'feat: aman')
})

test('baris terakhir keluaran: warna dan bilah progres dibersihkan, baris kosong dilewati', () => {
  const ESC = String.fromCharCode(27)
  assert.equal(lastOutputLine('langkah 1\nlangkah 2\n\n'), 'langkah 2')
  assert.equal(lastOutputLine(`${ESC}[32m✓${ESC}[0m lulus\n`), '✓ lulus')
  assert.equal(lastOutputLine('unduh 10%\runduh 55%\runduh 90%'), 'unduh 90%')
  assert.equal(lastOutputLine(''), '')
})

test('argumen perintah latar belakang dan pemeriksaannya', () => {
  assert.equal(describeArgs('bash', { command: 'pnpm dev', run_in_background: true }), 'pnpm dev · background')
  assert.equal(describeArgs('bash', { command: 'node prompt.js', run_in_background: true, interactive: true }), 'node prompt.js · background · interactive')
  assert.equal(describeArgs('bash_output', { id: 'bg1' }), 'bg1')
  assert.equal(describeArgs('bash_input', { id: 'bg1', input: 'yes' }), 'bg1')
  assert.equal(toolActivity('bash_input'), 'Running')
})
