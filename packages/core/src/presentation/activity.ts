/**
 * Label aktivitas yang tampil di baris status selagi Boo bekerja.
 *
 * Setiap label berasal dari kejadian nyata di agent, bukan kata yang bergiliran
 * untuk hiasan: pengguna harus dapat memercayai bahwa "Writing" berarti berkas
 * memang sedang ditulis.
 */

export type ActivityLabel =
  | 'Thinking'
  | 'Orchestrating'
  | 'Generating'
  | 'Searching'
  | 'Reading'
  | 'Writing'
  | 'Implementing'
  | 'Running'
  | 'Checking'
  | 'Planning'
  | 'Waiting'

const TOOL_LABEL: Record<string, ActivityLabel> = {
  list_dir: 'Searching',
  glob: 'Searching',
  grep: 'Searching',
  tool_search: 'Searching',
  code_search: 'Searching',
  code_graph: 'Searching',
  change_impact: 'Checking',
  test_impact: 'Checking',
  repo_map: 'Searching',
  web_search: 'Searching',
  web_fetch: 'Reading',
  diagnostics: 'Checking',
  lsp: 'Checking',
  delegate: 'Orchestrating',
  delegate_write: 'Orchestrating',
  memory_list: 'Reading',
  memory_add: 'Writing',
  memory_remove: 'Writing',
  list_skills: 'Searching',
  read_skill: 'Reading',
  read_skill_resource: 'Reading',
  list_mcp_servers: 'Searching',
  mcp_list_tools: 'Checking',
  mcp_call: 'Running',
  git_status: 'Checking',
  git_changed_files: 'Checking',
  git_diff: 'Reading',
  git_log: 'Searching',
  git_show: 'Reading',
  git_blame: 'Reading',
  git_commit: 'Writing',
  list_apps: 'Searching',
  open_app: 'Running',
  computer_status: 'Checking',
  computer_snapshot: 'Reading',
  computer_click: 'Running',
  computer_type: 'Running',
  computer_press: 'Running',
  schedule_list: 'Reading',
  schedule_add: 'Planning',
  schedule_remove: 'Writing',
  trigger_list: 'Reading',
  trigger_add: 'Planning',
  trigger_remove: 'Writing',
  remote_node_list: 'Reading',
  remote_node_status: 'Checking',
  remote_node_snapshot: 'Reading',
  remote_node_click: 'Running',
  remote_node_type: 'Running',
  remote_node_press: 'Running',
  browser_status: 'Checking',
  browser_tabs: 'Reading',
  browser_open: 'Running',
  browser_navigate: 'Running',
  browser_snapshot: 'Reading',
  browser_diagnostics: 'Checking',
  browser_click: 'Running',
  browser_type: 'Running',
  browser_select: 'Running',
  browser_press: 'Running',
  whatsapp_status: 'Checking',
  whatsapp_send_message: 'Running',
  read_file: 'Reading',
  read_tool_output: 'Reading',
  write_file: 'Writing',
  edit_file: 'Implementing',
  apply_patch: 'Implementing',
  bash: 'Running',
  bash_output: 'Checking',
  bash_input: 'Running',
  bash_kill: 'Running',
  todo_write: 'Planning',
  ask_user: 'Waiting',
}

/** Label untuk tool; tool yang tidak dikenal dianggap mengubah sesuatu. */
export function toolActivity(tool: string): ActivityLabel {
  return TOOL_LABEL[tool] ?? 'Running'
}

/**
 * Putaran pertama adalah jawaban atas permintaan baru; putaran berikutnya adalah
 * model yang memutuskan langkah setelah hasil tool kembali.
 */
export function turnActivity(turn: number): ActivityLabel {
  return turn === 0 ? 'Thinking' : 'Orchestrating'
}

/** Cukup untuk menemukan `path` yang lazim diletakkan model di awal argumen. */
const HEAD_LIMIT = 512
const PATH_PATTERN = /"path"\s*:\s*"((?:\\.|[^"\\])*)"/

/**
 * Mengikuti argumen pemanggilan tool yang sedang mengalir.
 *
 * Argumen write_file adalah isi berkas utuh dan bisa sangat besar, jadi setiap
 * potongan diproses sekali saja: `path` dicari di bagian awal, dan baris dihitung
 * dari penanda `\n` yang ter-escape di dalam JSON. Penanda itu dapat terbelah di
 * antara dua potongan, sehingga karakter terakhir potongan sebelumnya diingat.
 */
export class ToolCallProgress {
  readonly name: string
  private head = ''
  private escapedNewlines = 0
  private trailingBackslash = false
  private resolvedPath: string | undefined

  constructor(name: string) {
    this.name = name
  }

  add(delta: string): void {
    if (!delta) return
    if (this.resolvedPath === undefined && this.head.length < HEAD_LIMIT) {
      this.head += delta
      const match = PATH_PATTERN.exec(this.head)
      if (match) {
        try {
          this.resolvedPath = JSON.parse(`"${match[1]}"`) as string
        } catch {
          this.resolvedPath = match[1]
        }
      }
    }

    let backslash = this.trailingBackslash
    for (const character of delta) {
      if (backslash) {
        if (character === 'n') this.escapedNewlines += 1
        backslash = false
      } else if (character === '\\') {
        backslash = true
      }
    }
    this.trailingBackslash = backslash
  }

  get path(): string | undefined {
    return this.resolvedPath
  }

  /**
   * Baris isi yang sudah selesai ditulis; hanya bermakna untuk write_file.
   *
   * Baris yang masih ditulis tidak ikut dihitung. Menghitungnya membuat angka
   * melompat mundur di akhir — berkas 30 baris yang diakhiri baris baru sempat
   * tampil 31 sebelum hitungan final saat tool dijalankan menjadi 30.
   */
  get lines(): number {
    return this.escapedNewlines
  }

  /** Keterangan singkat, misalnya "src/app.ts · 42 lines". */
  describe(): string {
    if (!this.path) return ''
    if (this.name !== 'write_file' || this.lines === 0) return this.path
    return `${this.path} · ${pluralLines(this.lines)}`
  }
}

/**
 * Jumlah baris seperti yang ditunjukkan editor: baris baru di akhir berkas tidak
 * membuka baris tambahan, sehingga berkas 30 baris tidak terhitung 31.
 */
export function countLines(content: string): number {
  if (!content) return 0
  const newlines = content.split('\n').length - 1
  return content.endsWith('\n') ? newlines : newlines + 1
}

function pluralLines(count: number): string {
  return `${count} line${count === 1 ? '' : 's'}`
}

/**
 * Keterangan dari argumen utuh saat tool mulai dijalankan: path untuk tool berkas,
 * perintah untuk bash, dan jumlah baris untuk berkas yang ditulis.
 */
export function describeArgs(tool: string, args: Record<string, unknown>): string {
  if (tool === 'tool_search' && typeof args.query === 'string') return `“${args.query}”`
  if (tool === 'ask_user' && Array.isArray(args.questions)) return `${args.questions.length} question${args.questions.length === 1 ? '' : 's'}`
  if (tool === 'git_commit' && typeof args.message === 'string') return args.message.split(/\r?\n/, 1)[0]
  if ((tool === 'git_log' || tool === 'git_show' || tool === 'git_blame') && typeof args.path === 'string') return args.path
  if (typeof args.command === 'string') {
    if (!args.run_in_background) return args.command
    return `${args.command} · background${args.interactive ? ' · interactive' : ''}`
  }
  if ((tool === 'bash_output' || tool === 'bash_input' || tool === 'bash_kill') && typeof args.id === 'string') return args.id
  if (tool === 'open_app' && typeof args.id === 'string') return args.id
  if (tool === 'browser_open' && typeof args.url === 'string') return args.url
  if (tool.startsWith('browser_') && typeof args.description === 'string') return args.description
  if (tool.startsWith('browser_') && typeof args.tab_id === 'string') return args.tab_id
  if (tool === 'whatsapp_send_message' && typeof args.recipient === 'string') return args.recipient
  if (tool === 'mcp_list_tools' && typeof args.server === 'string') return args.server
  if (tool === 'mcp_call' && typeof args.server === 'string' && typeof args.tool === 'string') return `${args.server}/${args.tool}`
  if (tool === 'delegate' && Array.isArray(args.tasks)) return `${args.tasks.length} read-only task${args.tasks.length === 1 ? '' : 's'}`
  if (tool === 'delegate_write' && Array.isArray(args.tasks)) return `${args.tasks.length} isolated implementation task${args.tasks.length === 1 ? '' : 's'}`
  if (tool === 'memory_add' && typeof args.text === 'string') return args.text
  if (tool === 'memory_remove' && typeof args.id === 'string') return args.id
  if (tool === 'web_search' && typeof args.query === 'string') return `“${args.query}”`
  if (tool === 'web_fetch' && typeof args.url === 'string') return args.url
  if ((tool === 'grep' || tool === 'glob') && typeof args.pattern === 'string') {
    const where = typeof args.path === 'string' && args.path !== '.' ? ` in ${args.path}` : ''
    return tool === 'grep' ? `"${args.pattern}"${where}` : `${args.pattern}${where}`
  }
  if (tool === 'code_search' && typeof args.query === 'string') return `"${args.query}"${typeof args.path === 'string' ? ` in ${args.path}` : ''}`
  if ((tool === 'change_impact' || tool === 'test_impact') && Array.isArray(args.changed_files)) return `${args.changed_files.length} changed file${args.changed_files.length === 1 ? '' : 's'}`
  if (tool === 'repo_map') {
    if (typeof args.query === 'string' && args.query) return `"${args.query}"${typeof args.path === 'string' ? ` in ${args.path}` : ''}`
    return typeof args.path === 'string' ? args.path : '.'
  }
  const path = typeof args.path === 'string' ? args.path : tool === 'list_dir' ? '.' : ''
  if (tool === 'read_file' && path && typeof args.offset === 'number') {
    return typeof args.limit === 'number'
      ? `${path} · lines ${args.offset}–${args.offset + args.limit - 1}`
      : `${path} · from line ${args.offset}`
  }
  if (tool === 'write_file' && path && typeof args.content === 'string') {
    return `${path} · ${pluralLines(countLines(args.content))}`
  }
  return path
}

/**
 * Baris terakhir yang berisi dari keluaran perintah yang sedang mengalir, untuk
 * baris status. Warna dan bilah progres yang ditulis ulang dengan carriage return
 * dibersihkan, agar yang tampil adalah keadaan terakhirnya.
 */
export function lastOutputLine(output: string): string {
  const ESC = String.fromCharCode(27)
  const lines = output
    .replace(new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, 'g'), '')
    .split('\n')
    .map((line) => line.slice(line.lastIndexOf('\r', line.length - 2) + 1).replace(/\r$/, '').trim())
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index]) return lines[index].replace(/\s+/g, ' ')
  }
  return ''
}
