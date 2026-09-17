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

const TOOL_LABEL: Record<string, ActivityLabel> = {
  list_dir: 'Searching',
  glob: 'Searching',
  grep: 'Searching',
  read_file: 'Reading',
  write_file: 'Writing',
  edit_file: 'Implementing',
  bash: 'Running',
  bash_output: 'Checking',
  bash_kill: 'Running',
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
  if (typeof args.command === 'string') return args.run_in_background ? `${args.command} · background` : args.command
  if ((tool === 'bash_output' || tool === 'bash_kill') && typeof args.id === 'string') return args.id
  if ((tool === 'grep' || tool === 'glob') && typeof args.pattern === 'string') {
    const where = typeof args.path === 'string' && args.path !== '.' ? ` in ${args.path}` : ''
    return tool === 'grep' ? `"${args.pattern}"${where}` : `${args.pattern}${where}`
  }
  const path = typeof args.path === 'string' ? args.path : tool === 'list_dir' ? '.' : ''
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
