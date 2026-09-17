#!/usr/bin/env node
/**
 * CLI `boo` — antarmuka terminal untuk agent Boo.
 *
 * Seluruh logika agent berada di @boo/core; file ini hanya menggambar hasilnya
 * dan menanyakan izin. Web nanti memakai core yang sama dengan penggambar
 * berbeda.
 */

import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { existsSync, readFileSync } from 'node:fs'
import {
  Agent,
  createDefaultRegistry,
  describeSelection,
  diffStats,
  findSelection,
  groupModels,
  NineRouterProvider,
  resolveInWorkspace,
  type AgentOptions,
  type Message,
  type ModelFamily,
  type RepairResult,
} from '@boo/core'
import { GLOBAL_CONFIG_PATH, loadConfig } from './config.ts'
import { describeArgs, ToolCallProgress, toolActivity, turnActivity } from './activity.ts'
import { commandBody, describeRequest, diffBody, renderPanel } from './approval.ts'
import { MarkdownRenderer } from './markdown.ts'
import { select } from './select.ts'
import { renderTranscript } from './transcript.ts'
import {
  listSessions,
  loadSession,
  relativeTime,
  SessionError,
  SessionRecorder,
  shortId,
  type LoadedSession,
  type SessionSummary,
} from './sessions.ts'
import { PhaseTally, phaseOf, StatusLine } from './status.ts'
import { banner, theme } from './theme.ts'

const DEFAULT_MODEL = 'ag/claude-sonnet-4-6'

/**
 * Jeda sebelum spinner muncul selagi baris jawaban belum lengkap. Tanpa jeda,
 * butir daftar yang datang beruntun membuat spinner berkedip di antara baris.
 */
const WAITING_INDICATOR_MS = 200
/** Batas lebar teks jawaban; baris yang terlalu panjang sulit dibaca. */
const MAX_ANSWER_WIDTH = 120

/**
 * Keluarga yang tampil di halaman pertama /model, sesuai urutan yang diminta.
 * Hanya yang benar-benar tersedia di 9Router yang ditampilkan; sisanya tetap
 * dapat dijangkau lewat "Model lain…" supaya tidak ada model yang hilang —
 * termasuk model bawaan.
 */
const FEATURED_FAMILIES = [
  'ag/gemini-3.5-flash',
  'ag/gemini-3.7-flash',
  'ag/gemini-3.1-pro',
  'ag/claude-sonnet-4-6',
  'ag/claude-opus-4-6-thinking',
  'cx/gpt-5.6-luna',
  'cx/gpt-5.6-terra',
  'cx/gpt-5.6-sol',
]

const OTHER_MODELS_LABEL = 'Model lain…'
const DEFAULT_BASE_URL = 'http://localhost:20128'

const VERBOSE = process.argv.includes('--verbose')

function version(): string {
  try {
    const manifest = new URL('../package.json', import.meta.url)
    return (JSON.parse(readFileSync(manifest, 'utf8')) as { version?: string }).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

const USAGE = `boo — coding agent oleh FLdev

  boo                      mulai sesi di direktori saat ini
  boo <id>                 langsung buka sesi tertentu, misal: boo 5bd73640
  boo --resume             pilih sesi dari daftar
  boo --resume <id>        langsung buka sesi tertentu
  boo --continue           lanjutkan sesi terakhir di direktori ini
  boo --model <id>         pilih model untuk sesi ini
  boo --effort <tingkat>   low, medium, high, atau xhigh (model Codex)
  boo --verbose            tampilkan keluaran tool selengkapnya
  boo --version            tampilkan versi
  boo --help               tampilkan bantuan ini

Konfigurasi dibaca berlapis; yang belakangan menimpa yang sebelumnya:

  ${GLOBAL_CONFIG_PATH}
  <direktori kerja>/.env
  <direktori kerja>/.env.local
  environment variable

Isi minimal:

  NINEROUTER_URL=http://localhost:20128
  NINEROUTER_KEY=sk-...
  BOO_MODEL=ag/claude-sonnet-4-6
  BOO_EFFORT=medium`

const HELP = `  /model          pilih model dengan tombol panah
  /model <id> [tingkat]
                  ganti langsung, misal /model cx/gpt-5.6-sol xhigh
  /resume         pilih dan lanjutkan sesi lain di direktori ini
  /queue          lihat permintaan yang mengantre
  /queue hapus    kosongkan antrean
  /help           tampilkan bantuan ini
  /keluar         akhiri sesi

Mengetik selagi Boo bekerja tidak memotong pekerjaannya; permintaan
itu masuk antrean dan dijalankan setelah yang sekarang selesai.`

/**
 * Nama model dan tingkat penalaran yang mudah dibaca, misalnya
 * "GPT-5.6 Sol · Extra High". Diturunkan dari id model saja, tanpa memanggil
 * 9Router, supaya aman dipakai setiap kali prompt digambar.
 */
function modelLabel(model: string, effort: string | undefined): string {
  return describeSelection(groupModels([model]), model, effort)
}

type ResumeRequest =
  | { mode: 'new' }
  | { mode: 'continue' }
  | { mode: 'pick' }
  | { mode: 'id'; id: string }

/** Membaca --resume [id] dan --continue. Nilai yang diawali "-" adalah bendera lain. */
/** Bendera yang selalu diikuti nilai; nilainya bukan argumen posisi. */
const VALUE_FLAGS = new Set(['--model', '-m', '--effort'])

/**
 * Argumen tanpa bendera. Nilai milik bendera lain dilewati, sehingga
 * `boo --model cx/gpt-5.5` tidak menganggap `cx/gpt-5.5` sebagai id sesi.
 */
function positionalArgs(): string[] {
  const args = process.argv.slice(2)
  const positional: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (VALUE_FLAGS.has(arg)) {
      index += 1
      continue
    }
    if (arg === '--resume' || arg === '-r') {
      if (args[index + 1] && !args[index + 1].startsWith('-')) index += 1
      continue
    }
    if (!arg.startsWith('-')) positional.push(arg)
  }
  return positional
}

/**
 * `boo --resume` menampilkan daftar untuk dipilih; `boo --resume <id>` dan
 * `boo <id>` langsung membuka sesi itu tanpa memilih.
 */
function resumeRequest(): ResumeRequest {
  const args = process.argv.slice(2)
  if (args.includes('--continue') || args.includes('-c')) return { mode: 'continue' }
  const inline = args.find((arg) => arg.startsWith('--resume='))
  if (inline) return { mode: 'id', id: inline.slice('--resume='.length) }
  const index = args.findIndex((arg) => arg === '--resume' || arg === '-r')
  if (index !== -1) {
    const next = args[index + 1]
    return next && !next.startsWith('-') ? { mode: 'id', id: next } : { mode: 'pick' }
  }
  const positional = positionalArgs()
  if (positional.length > 1) {
    fail(`Argumen tidak dikenal: ${positional.slice(1).join(' ')}`, 'Pakai `boo <id>` untuk membuka satu sesi, atau `boo --help`.')
  }
  return positional.length ? { mode: 'id', id: positional[0] } : { mode: 'new' }
}

function fail(message: string, hint?: string): never {
  console.error(theme.danger(message))
  if (hint) console.error(theme.muted(hint))
  process.exit(1)
}

/**
 * Menentukan sesi yang dilanjutkan, atau null untuk sesi baru.
 *
 * Sesi terikat ke direktori asalnya. Riwayatnya merujuk berkas di direktori itu,
 * dan workspace adalah batas yang tidak boleh dilewati tool — melanjutkannya dari
 * direktori lain akan membuat agent bertindak atas berkas yang keliru.
 */
async function resolveResume(request: ResumeRequest, workspace: string): Promise<LoadedSession | null> {
  if (request.mode === 'new') return null

  let session: LoadedSession
  try {
    if (request.mode === 'id') {
      session = loadSession(request.id)
    } else {
      const summaries = listSessions(workspace)
      if (!summaries.length) {
        fail('Belum ada sesi tersimpan untuk direktori ini.', 'Mulai sesi baru dengan `boo`.')
      }
      if (request.mode === 'continue') {
        session = loadSession(summaries[0].id)
      } else {
        const labels = sessionLabels(summaries)
        // Pemilih butuh readline; yang ini sementara dan ditutup sebelum sesi dimulai,
        // karena readline utama harus dibuat dengan riwayat ketikan sesi terpilih.
        const temporary = createInterface({ input: stdin, output: stdout })
        const picked = await select(temporary, {
          title: 'Lanjutkan sesi',
          items: labels,
          initialIndex: 0,
          hint: 'panah atas/bawah memilih, enter melanjutkan, esc membatalkan',
        })
        temporary.close()
        if (picked === undefined) {
          console.log(`  ${theme.bold('Sesi di direktori ini')}`)
          labels.forEach((label) => console.log(`  ${label}`))
          fail('Terminal ini tidak mendukung pemilih.', 'Jalankan `boo --resume <id>` dengan id dari daftar di atas.')
        }
        if (picked === null) {
          console.log(`  ${theme.muted('dibatalkan')}`)
          process.exit(0)
        }
        session = loadSession(summaries[picked].id)
      }
    }
  } catch (error) {
    if (error instanceof SessionError) fail(error.message, 'Jalankan `boo --resume` untuk memilih dari daftar sesi.')
    throw error
  }

  if (session.workspace !== workspace) {
    fail(
      `Sesi ${shortId(session.id)} berasal dari ${session.workspace}.`,
      `Lanjutkan dari direktori itu:  cd ${session.workspace} && boo --resume ${shortId(session.id)}`,
    )
  }
  return session
}

/** Baris pemilih sesi: id pendek, waktu, lalu pertanyaan pertama. */
function sessionLabels(summaries: SessionSummary[]): string[] {
  return summaries.map((item) => `${shortId(item.id)}  ${relativeTime(item.updatedAt).padEnd(14)}  ${item.title}`)
}

/** Riwayat panah atas dari sebuah sesi: pertanyaannya, terbaru lebih dulu. */
function promptsOf(messages: Message[]): string[] {
  return messages
    .filter((message) => message.role === 'user' && message.content)
    .map((message) => message.content as string)
    .reverse()
}

/** Membaca nilai bendera seperti --model atau --effort dari argumen baris perintah. */
function flagValue(name: string, short?: string): string | undefined {
  const args = process.argv.slice(2)
  const index = args.findIndex((arg) => arg === `--${name}` || (short && arg === `-${short}`))
  if (index !== -1 && args[index + 1]) return args[index + 1]
  return args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
}

/**
 * Memastikan tingkat penalaran berlaku untuk model tersebut.
 *
 * Mengirim `reasoning_effort` ke model yang tidak menerimanya membuat upstream
 * menolak, dan 9Router lalu mengunci model itu beberapa puluh detik untuk semua
 * permintaan berikutnya. Karena itu tingkat yang tidak cocok dibuang di sini.
 */
function validEffort(model: string, effort: string | undefined): string | undefined {
  if (!effort) return undefined
  const [family] = groupModels([model])
  if (family?.source !== 'parameter') return undefined
  return family.options.some((option) => option.reasoningEffort === effort) ? effort : undefined
}

function requireKey(key: string | undefined): string {
  if (key) return key
  console.error(theme.danger('NINEROUTER_KEY belum dikonfigurasi.'))
  console.error(theme.muted(`Buat ${GLOBAL_CONFIG_PATH} berisi:`))
  console.error(theme.muted('  NINEROUTER_URL=http://localhost:20128'))
  console.error(theme.muted('  NINEROUTER_KEY=sk-...  (dari Dashboard 9Router)'))
  console.error(theme.muted('Atau letakkan .env.local di direktori kerja.'))
  process.exit(1)
}

/**
 * Mengambil berkas yang disentuh dari keterangan tool, misalnya "ubah hitung.js"
 * menjadi "hitung.js", untuk ringkasan fase menerapkan.
 */
function targetOf(preview: string): string {
  return preview.split(/\s+/)[1] ?? ''
}

/** Memangkas keluaran tool agar terminal tidak tenggelam oleh isi file. */
function summarize(content: string, maxLines = 6): string {
  const lines = content.split('\n')
  if (lines.length <= maxLines) return lines.map((line) => `    ${line}`).join('\n')
  const shown = lines.slice(0, maxLines).map((line) => `    ${line}`).join('\n')
  return `${shown}\n    ${theme.muted(`… ${lines.length - maxLines} baris lagi`)}`
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(USAGE)
    return
  }
  if (process.argv.includes('--version') || process.argv.includes('-V')) {
    console.log(version())
    return
  }

  const workspace = process.cwd()
  const config = loadConfig(workspace)
  const resumed = await resolveResume(resumeRequest(), workspace)

  // Urutan prioritas: bendera baris perintah, lalu model terakhir sesi yang
  // dilanjutkan, lalu konfigurasi, lalu bawaan.
  const flagModel = flagValue('model', 'm')
  const fromSession = !flagModel && Boolean(resumed?.model)
  const model = flagModel || resumed?.model || config.BOO_MODEL || DEFAULT_MODEL
  const requestedEffort = flagValue('effort') || (fromSession ? resumed?.reasoningEffort : config.BOO_EFFORT)
  const reasoningEffort = validEffort(model, requestedEffort)
  if (requestedEffort && !reasoningEffort) {
    console.error(theme.muted(`Tingkat "${requestedEffort}" tidak berlaku untuk ${model}; diabaikan.`))
  }

  const provider = new NineRouterProvider({
    baseUrl: config.NINEROUTER_URL || DEFAULT_BASE_URL,
    apiKey: requireKey(config.NINEROUTER_KEY),
    model,
    reasoningEffort,
  })

  // Pertanyaan sesi sebelumnya dipulihkan ke riwayat panah atas, terbaru lebih dulu.
  const previousPrompts = promptsOf(resumed?.messages ?? [])
  const readline = createInterface({ input: stdin, output: stdout, history: previousPrompts, historySize: 200 })

  /**
   * Satu pintu untuk keluaran selama Boo bekerja.
   *
   * Keluaran dan baris ketik berbagi satu kursor. Menulis tanpa memperhatikannya
   * pernah menghapus teks: spinner digambar di baris kalimat pengantar model dan
   * menghapusnya, dan baris ketik yang digambar ulang di tengah jawaban ikut
   * membersihkan baris jawaban itu.
   *
   * - `midLine` mencatat apakah aliran keluaran berhenti di tengah baris, supaya
   *   spinner dan baris ketik selalu mendapat baris sendiri.
   * - Selama pengguna mengetik permintaan berikutnya, keluaran ditahan lalu
   *   dilepas setelah ketikan dikirim atau dihapus, agar tidak menyusup ke
   *   tengah baris ketik.
   */
  let midLine = false
  let typing = false
  /** Aliran keluaran berhenti di tengah baris ketika pengguna mulai mengetik. */
  let resumeIndent = false
  const held: string[] = []

  function emit(text: string): void {
    if (!text) return
    if (typing) {
      held.push(text)
      midLine = !text.endsWith('\n')
      return
    }
    // Lanjutan baris yang terputus oleh baris ketik berada di baris baru dan perlu
    // indentasinya kembali. Hanya lanjutan itu yang diberi indentasi: baris yang
    // sudah utuh, seperti catatan antrean, dilewati dan tanda tetap menunggu.
    if (resumeIndent) {
      if (text.startsWith('\n')) resumeIndent = false
      else if (!text.startsWith(' ')) {
        resumeIndent = false
        text = `  ${text}`
      }
    }
    stdout.write(text)
    midLine = !text.endsWith('\n')
  }

  /** Mengakhiri keadaan mengetik dan melepas keluaran yang sempat ditahan. */
  function stopTyping(clearInputLine: boolean): void {
    if (!typing) return
    typing = false
    if (clearInputLine) stdout.write('\r\u001b[2K')
    const output = held.join('')
    held.length = 0
    // Lewat emit agar lanjutan baris yang terputus mendapat indentasinya.
    emit(output)
    status.resume()
  }

  const status = new StatusLine(emit)

  // Dapat diganti oleh /resume; setiap penutup membaca nilai terkini lewat binding ini.
  let recorder = new SessionRecorder({ workspace, model, reasoningEffort, resumeId: resumed?.id })
  // Bendera --model atau --effort saat melanjutkan mengganti model sesi itu.
  if (resumed && (model !== resumed.model || reasoningEffort !== resumed.reasoningEffort)) {
    recorder.recordModel(model, reasoningEffort)
  }

  function printResumeHint(): void {
    if (!recorder.started) return
    console.log(`\n  ${theme.muted('Lanjutkan sesi ini:')} boo --resume ${shortId(recorder.id)}`)
  }

  // Ctrl-C pertama menutup sesi dengan tertib; bila Boo masih bekerja, pekerjaan
  // itu diselesaikan dulu. Ctrl-C kedua keluar seketika — aman, karena setiap pesan
  // sudah ditulis ke berkas sesi begitu masuk ke riwayat.
  let interrupted = false
  readline.on('SIGINT', () => {
    if (interrupted) {
      status.clear()
      printResumeHint()
      process.exit(130)
    }
    interrupted = true
    if (busy) {
      status.note(`  ${theme.muted('menyelesaikan pekerjaan yang sedang berjalan; Ctrl-C lagi untuk keluar sekarang')}`)
    }
    readline.close()
  })

  /**
   * Antrean baris sendiri, bukan readline.question().
   *
   * Pada stdin yang dipipe, question() hanya mengambil satu baris lalu stream
   * berakhir dan sisa baris yang sudah tersimpan ikut hilang. Dengan menampung
   * event 'line' sendiri, `boo` bekerja sama pada terminal interaktif maupun
   * input yang dipipe. Nilai null berarti masukan sudah habis.
   */
  const buffered: string[] = []
  const waiting: Array<(line: string | null) => void> = []
  let ended = false

  /**
   * Antrean permintaan yang diketik selagi Boo masih bekerja.
   *
   * Antrean ini sengaja terpisah dari `buffered`. Permintaan izin juga membaca
   * masukan, dan bila keduanya berbagi satu tumpukan, permintaan yang baru
   * diketik akan termakan sebagai jawaban "y/N" atas izin yang sedang menunggu.
   * Ketikan saat sibuk hanya menjadi tugas berikutnya; penanya yang aktif selalu
   * dilayani lebih dulu.
   */
  const pending: string[] = []
  let busy = false

  /**
   * Menampilkan atau mengosongkan antrean.
   *
   * Dipanggil juga langsung dari penangan 'line' saat Boo sedang bekerja: justru
   * pada saat itulah perintah ini dibutuhkan, sehingga mengantrekannya hanya
   * akan menunda jawaban sampai antreannya sudah telanjur habis.
   */
  function queueCommand(argument: string): void {
    if (argument === 'hapus' || argument === 'clear') {
      const dibuang = pending.length
      pending.length = 0
      console.log(`  ${theme.muted(`${dibuang} permintaan dibuang dari antrean`)}\n`)
      return
    }
    if (!pending.length) {
      console.log(`  ${theme.muted('antrean kosong')}\n`)
      return
    }
    console.log()
    pending.forEach((item, index) => {
      console.log(`  ${theme.muted(String(index + 1).padStart(3))}  ${item}`)
    })
    console.log()
  }

  function isQueueCommand(text: string): boolean {
    return text === '/queue' || text.startsWith('/queue ')
  }

  readline.on('line', (line) => {
    const waiter = waiting.shift()
    if (waiter) {
      // Terminal interaktif sudah menggemakan ketikan; stdin yang dipipe tidak,
      // sehingga prompt akan menempel pada keluaran berikutnya tanpa ini.
      if (!stdout.isTTY) stdout.write(`${line}\n`)
      waiter(line)
      return
    }
    if (busy) {
      // readline sudah pindah baris setelah Enter; lepaskan keluaran yang ditahan.
      stopTyping(false)
      const text = line.trim()
      if (!text) return
      if (isQueueCommand(text)) {
        status.pause()
        queueCommand(text.slice('/queue'.length).trim())
        status.resume()
        return
      }
      pending.push(text)
      status.note(`  ${theme.muted(`antre #${pending.length}  ${text}`)}`)
      return
    }
    buffered.push(line)
  })
  readline.on('close', () => {
    ended = true
    while (waiting.length) waiting.shift()?.(null)
  })

  // Spinner dan ketikan berbagi satu baris. Begitu pengguna menekan tombol saat
  // Boo bekerja, animasi dihentikan agar readline memiliki barisnya sendiri.
  if (stdin.isTTY) {
    // Dipasang di depan pendengar readline, sehingga baris ketik sudah punya
    // tempat sendiri sebelum readline menggemakan huruf pertama.
    stdin.prependListener('keypress', (_: string, key: { name?: string; ctrl?: boolean } = {}) => {
      if (!busy || typing) return
      if (key.ctrl || key.name === 'return' || key.name === 'enter') return
      typing = true
      status.pause()
      if (midLine) {
        stdout.write('\n')
        resumeIndent = true
      }
      readline.prompt(true)
    })
    // Dipasang di belakang readline, agar isi baris sudah diperbarui: ketikan yang
    // dihapus seluruhnya melepas keluaran yang ditahan.
    stdin.on('keypress', () => {
      if (busy && typing && readline.line.length === 0) stopTyping(true)
    })
  }

  function ask(prompt: string): Promise<string | null> {
    const queued = buffered.shift()
    if (queued !== undefined) {
      stdout.write(`${prompt}${queued}\n`)
      return Promise.resolve(queued)
    }
    if (ended) return Promise.resolve(null)
    // Prompt digambar readline sendiri; menulisnya lewat stdout.write akan
    // ditimpa oleh prompt bawaan readline saat ia menggambar ulang barisnya.
    readline.setPrompt(prompt)
    readline.prompt()
    return new Promise((resolve) => waiting.push(resolve))
  }

  const ESC = String.fromCharCode(27)
  /**
   * Izin yang diberikan untuk sisa sesi lewat pilihan kedua panel. Perubahan berkas
   * disetujui sebagai satu kelompok, tetapi perintah shell hanya per perintah persis:
   * menyetujui `pnpm test` tidak boleh ikut meloloskan perintah lain.
   */
  const sessionApprovals = new Set<string>()
  function approvalKeyOf(kind: string, tool: string, command: string): string {
    if (kind === 'edit') return 'edit'
    if (kind === 'command') return `command:${command}`
    return `tool:${tool}`
  }
  function recordDecision(allowed: boolean, text: string): void {
    emit(`  ${allowed ? theme.accent('✓') : theme.danger('✗')} ${theme.muted(text)}\n`)
  }

  const agentOptions: Omit<AgentOptions, 'history' | 'onMessage'> = {
    provider,
    registry: createDefaultRegistry(),
    workspace,
    ...(config.BOO_MAX_CONTEXT_TOKENS
      ? { maxContextTokens: Number(config.BOO_MAX_CONTEXT_TOKENS) }
      : {}),
    async askPermission({ name, args, detail }) {
      // Baris status hidup harus dibuang dulu; spinner akan menimpa panel izin.
      stopTyping(true)
      status.clear()
      if (midLine) emit('\n')

      let fileExists: boolean
      try {
        fileExists = typeof args.path === 'string' && existsSync(resolveInWorkspace(workspace, args.path))
      } catch {
        // Path di luar workspace: tool akan menolaknya; anggap berkas baru.
        fileExists = false
      }
      const request = describeRequest(name, args, fileExists)
      const command = typeof args.command === 'string' ? args.command : ''
      const approvalKey = approvalKeyOf(request.kind, name, command)
      // Catatan keputusan memuat apa yang benar-benar disetujui: perintahnya, bukan
      // deskripsi yang ditulis model tentang perintah itu.
      const summary = request.kind === 'command'
        ? `${request.title} · ${command}`
        : request.subject ? `${request.title} ${request.subject}` : request.title

      if (sessionApprovals.has(approvalKey)) {
        recordDecision(true, `${summary} · diizinkan otomatis di sesi ini`)
        return true
      }

      const columns = stdout.columns || 80
      const rows = stdout.rows || 24
      const width = Math.max(40, Math.min(columns - 2, 100))
      // Pertanyaan dan pilihan memakai sekitar sepuluh baris; sisanya untuk isi panel.
      const bodyLimit = Math.max(6, rows - 16)
      const body = request.kind === 'command'
        ? commandBody(command, width - 4)
        : detail?.length ? diffBody(detail, request.subject, width - 4, bodyLimit) : []
      const panel = renderPanel(request, body, width, detail?.length ? diffStats(detail) : undefined)
      emit(`\n${panel.join('\n')}\n`)
      const panelHeight = panel.length + 1

      const choice = await select(readline, {
        title: request.question,
        items: ['Ya', request.allowAlways, 'Tidak, beri tahu Boo apa yang harus dilakukan'],
        initialIndex: 0,
        numbered: true,
        hint: 'panah memilih · enter memakai · 1-3 pintasan · esc menolak',
      })

      if (choice === undefined) {
        // Terminal tanpa raw mode: panel tetap tampil dan jawabannya diketik.
        const answer = await ask(`  ${request.question} [y/N] `)
        const allowed = answer?.trim().toLowerCase() === 'y'
        recordDecision(allowed, `${summary} · ${allowed ? 'diizinkan' : 'ditolak'}`)
        return allowed
      }

      // Pemilih sudah menghapus dirinya; panel ikut dihapus sehingga riwayat
      // terminal hanya memuat satu baris keputusan. Panel yang lebih tinggi dari
      // layar tidak terjangkau kursor, jadi dibiarkan daripada terhapus sebagian.
      if (panelHeight < rows) stdout.write(`${ESC}[${panelHeight}A${ESC}[0J`)

      if (choice === 0) {
        recordDecision(true, `${summary} · diizinkan`)
        return true
      }
      if (choice === 1) {
        sessionApprovals.add(approvalKey)
        const scope = request.kind === 'edit' ? 'semua perubahan berkas' : request.kind === 'command' ? 'perintah ini' : name
        recordDecision(true, `${summary} · ${scope} diizinkan untuk sisa sesi`)
        return true
      }
      if (choice === 2) {
        const feedback = (await ask(`  ${theme.accent('✎')} ${theme.bold('Arahan untuk Boo:')} `))?.trim() ?? ''
        // Baris ketik arahan dihapus; isinya tercatat di baris keputusan.
        stdout.write(`${ESC}[1A${ESC}[2K`)
        recordDecision(false, feedback ? `${summary} · ditolak: ${feedback}` : `${summary} · ditolak`)
        return { allowed: false, ...(feedback ? { feedback } : {}) }
      }
      recordDecision(false, `${summary} · ditolak`)
      return { allowed: false }
    },
  }

  /** Agent dibuat ulang saat berpindah sesi, dengan riwayat sesi yang dipilih. */
  function createAgent(history: Message[] | undefined): Agent {
    return new Agent({ ...agentOptions, history, onMessage: (message) => recorder.recordMessage(message) })
  }
  let agent = createAgent(resumed?.messages)

  /**
   * Memilih satu item dari daftar dan mengembalikan indeksnya, atau null bila
   * dibatalkan. Tombol panah dipakai bila terminal mendukung; selain itu daftar
   * bernomor diketik, supaya `boo` tetap berjalan saat input dipipe.
   */
  async function choose(
    title: string,
    labels: string[],
    activeIndex: number,
    initialIndex = activeIndex,
  ): Promise<number | null> {
    const picked = await select(readline, {
      title,
      items: labels,
      activeIndex,
      initialIndex: Math.max(0, initialIndex),
      activeLabel: '(aktif)',
      hint: 'panah atas/bawah memilih, enter memakai, esc membatalkan',
    })
    if (picked !== undefined) return picked

    console.log(`\n  ${theme.bold(title)}`)
    labels.forEach((label, index) => {
      const active = index === activeIndex ? theme.muted(' (aktif)') : ''
      console.log(`  ${theme.muted(String(index + 1).padStart(3))}  ${label}${active}`)
    })
    const answer = (await ask(`\n  ${theme.muted('nomor [enter untuk batal] ')}`))?.trim()
    const choice = Number(answer)
    return answer && Number.isInteger(choice) && choice >= 1 && choice <= labels.length ? choice - 1 : null
  }

  function applyModel(families: ModelFamily[], modelId: string, effort: string | undefined): void {
    provider.model = modelId
    // Selalu ditimpa, termasuk menjadi undefined: tingkat milik model sebelumnya
    // tidak boleh terbawa ke model yang tidak menerimanya.
    provider.reasoningEffort = effort
    recorder.recordModel(modelId, effort)
    console.log(`  ${theme.accent('model')} ${theme.bold(describeSelection(families, modelId, effort))}\n`)
  }

  /**
   * Mengganti model sesi berjalan; riwayat percakapan tetap dipertahankan.
   *
   * Dua langkah: pilih keluarga, lalu pilih tingkat penalaran. Langkah kedua
   * dilewati untuk keluarga yang hanya punya satu varian.
   */
  async function changeModel(requested: string): Promise<void> {
    if (requested) {
      const [modelId, effort] = requested.split(/\s+/)
      const accepted = validEffort(modelId, effort)
      if (effort && !accepted) {
        console.log(`  ${theme.danger('tingkat tidak berlaku')} ${theme.muted(`"${effort}" untuk ${modelId}`)}\n`)
        return
      }
      applyModel(groupModels([modelId]), modelId, accepted)
      return
    }

    let families: ModelFamily[]
    try {
      families = groupModels(await provider.listModels())
    } catch (error) {
      console.log(`  ${theme.danger('error')} ${error instanceof Error ? error.message : 'gagal'}\n`)
      return
    }
    if (!families.length) {
      console.log(`  ${theme.muted('9Router tidak mengembalikan model apa pun.')}\n`)
      return
    }

    const featured = FEATURED_FAMILIES
      .map((key) => families.find((family) => family.key === key))
      .filter((family): family is ModelFamily => Boolean(family))
    const others = families.filter((family) => !featured.includes(family))
    const current = findSelection(families, provider.model, provider.reasoningEffort)

    // Langkah 1: keluarga unggulan, dengan model lain dilipat di bawahnya.
    const firstPage = others.length ? [...featured.map((f) => f.label), OTHER_MODELS_LABEL] : featured.map((f) => f.label)
    const currentInFeatured = current ? featured.indexOf(current.family) : -1
    const firstActive = currentInFeatured !== -1 ? currentInFeatured : current && others.length ? featured.length : -1
    const firstPick = await choose('Pilih model', firstPage, firstActive)
    if (firstPick === null) {
      console.log(`  ${theme.muted('dibatalkan')}\n`)
      return
    }

    let family: ModelFamily
    if (firstPick === featured.length) {
      const otherActive = current ? others.indexOf(current.family) : -1
      const otherPick = await choose('Model lain', others.map((f) => f.label), otherActive)
      if (otherPick === null) {
        console.log(`  ${theme.muted('dibatalkan')}\n`)
        return
      }
      family = others[otherPick]
    } else {
      family = featured[firstPick]
    }

    // Langkah 2: tingkat penalaran, hanya bila memang ada pilihan.
    if (!family.source) {
      applyModel(families, family.options[0].modelId, undefined)
      return
    }
    // Kursor menunjuk tingkat yang sedang dipakai, atau medium sebagai saran
    // bawaan — tetapi saran itu tidak boleh ditandai "(aktif)".
    const sameFamily = current?.family === family ? family.options.indexOf(current.option) : -1
    const medium = family.options.findIndex((option) => option.level === 'medium')
    const effortPick = await choose(
      `${family.label} · tingkat penalaran`,
      family.options.map((option) => option.label),
      sameFamily,
      sameFamily !== -1 ? sameFamily : medium,
    )
    if (effortPick === null) {
      console.log(`  ${theme.muted('dibatalkan')}\n`)
      return
    }
    const option = family.options[effortPick]
    applyModel(families, option.modelId, option.reasoningEffort)
  }

  console.log(`\n${banner()}\n`)
  console.log(`  ${theme.accent('Boo Code')} ${theme.muted(`· ${modelLabel(model, reasoningEffort)} · ${workspace}`)}`)
  /** Keterangan dan ringkasan sesi yang baru saja dilanjutkan. */
  function showResumed(session: LoadedSession, restored: RepairResult | null): void {
    console.log(`  ${theme.muted(`melanjutkan sesi ${shortId(session.id)} · ${session.messages.length} pesan · ${relativeTime(session.updatedAt)}`)}`)
    // Percakapan ditampilkan ulang seperti saat berlangsung, bukan diringkas.
    const transcript = renderTranscript(session.messages, Math.min(stdout.columns || 100, MAX_ANSWER_WIDTH))
    if (transcript) process.stdout.write(`\n${transcript}`)

    // Laporkan perbaikan riwayat agar jawaban pengganti tidak mengejutkan.
    const notes: string[] = []
    if (session.skippedLines) notes.push(`${session.skippedLines} baris rusak dilewati`)
    if (restored?.filledToolResults) notes.push(`${restored.filledToolResults} tool yang terputus ditandai tidak dijalankan`)
    if (restored?.filledReplies) notes.push(`${restored.filledReplies} permintaan terputus ditandai belum dijawab`)
    if (notes.length) console.log(`\n  ${theme.muted(`sesi sebelumnya berhenti mendadak: ${notes.join(', ')}`)}`)
    console.log()
  }

  /**
   * Berpindah ke sesi lain tanpa keluar dari boo. Sesi yang sedang berjalan sudah
   * tersimpan pesan demi pesan, jadi tidak ada yang hilang saat ditinggalkan.
   */
  async function switchSession(): Promise<void> {
    const summaries = listSessions(workspace)
    if (!summaries.length) {
      console.log(`  ${theme.muted('belum ada sesi tersimpan di direktori ini')}\n`)
      return
    }
    const activeIndex = summaries.findIndex((summary) => summary.id === recorder.id)
    const labels = sessionLabels(summaries)
    const picked = await select(readline, {
      title: 'Lanjutkan sesi',
      items: labels,
      activeIndex,
      activeLabel: '(aktif)',
      initialIndex: Math.max(0, activeIndex),
      hint: 'panah atas/bawah memilih, enter melanjutkan, esc membatalkan',
    })
    if (picked === undefined) {
      console.log(`\n  ${theme.bold('Sesi di direktori ini')}`)
      labels.forEach((label) => console.log(`  ${label}`))
      console.log(`  ${theme.muted('terminal ini tidak mendukung pemilih; jalankan boo --resume <id>')}\n`)
      return
    }
    if (picked === null) {
      console.log(`  ${theme.muted('dibatalkan')}\n`)
      return
    }
    const target = summaries[picked]
    if (target.id === recorder.id) {
      console.log(`  ${theme.muted('sudah berada di sesi ini')}\n`)
      return
    }

    let session: LoadedSession
    try {
      session = loadSession(target.id)
    } catch (error) {
      console.log(`  ${theme.danger('error')} ${error instanceof Error ? error.message : 'sesi gagal dimuat'}\n`)
      return
    }

    const previous = recorder.started ? shortId(recorder.id) : null
    recorder = new SessionRecorder({
      workspace,
      model: session.model ?? provider.model,
      reasoningEffort: session.reasoningEffort,
      resumeId: session.id,
    })
    agent = createAgent(session.messages)
    if (session.model) {
      provider.model = session.model
      provider.reasoningEffort = validEffort(session.model, session.reasoningEffort)
    }
    // Izin "untuk sisa sesi" diberikan dalam konteks percakapan sebelumnya.
    sessionApprovals.clear()
    // readline tidak mengetikkan riwayatnya, tetapi menyimpannya di properti ini.
    const typedHistory = (readline as unknown as { history?: string[] }).history
    if (typedHistory) typedHistory.splice(0, typedHistory.length, ...promptsOf(session.messages))

    if (previous) console.log(`  ${theme.muted(`sesi ${previous} tersimpan`)}`)
    showResumed(session, agent.restored)
  }

  if (resumed) showResumed(resumed, agent.restored)
  console.log(`  ${theme.muted('ketik perintah, /help untuk daftar perintah')}\n`)

  for (;;) {
    // Nama model di baris sendiri dan tempat mengetik di bawahnya. Header dicetak
    // terpisah, bukan dijadikan bagian prompt: prompt readline yang memuat baris
    // baru rusak saat readline menggambar ulang barisnya, misalnya ketika riwayat
    // dipanggil atau ketikan dipulihkan setelah spinner berhenti.
    // Dibangun ulang setiap putaran agar selalu mencerminkan model yang sedang
    // dipakai, termasuk sesaat setelah /model mengubahnya.
    const header = `${theme.accentBold('boo')} ${theme.muted(`· ${modelLabel(provider.model, provider.reasoningEffort)}`)}`
    const promptText = `${theme.accentBold('›')} `
    let input: string

    // Permintaan yang sudah mengantre dikerjakan lebih dulu, berurutan.
    const queued = pending.shift()
    if (queued !== undefined) {
      const sisa = pending.length ? theme.muted(`  (${pending.length} lagi mengantre)`) : ''
      stdout.write(`${header}\n${promptText}${queued}${sisa}\n`)
      input = queued
    } else {
      stdout.write(`${header}\n`)
      const answer = await ask(promptText)
      if (answer === null) break
      input = answer.trim()
      if (!input) continue
    }
    if (input === '/keluar' || input === '/exit') break
    if (input === '/help') {
      console.log(`\n${HELP}\n`)
      continue
    }
    if (input === '/model' || input.startsWith('/model ')) {
      await changeModel(input.slice('/model'.length).trim())
      continue
    }
    if (isQueueCommand(input)) {
      queueCommand(input.slice('/queue'.length).trim())
      continue
    }
    if (input === '/resume') {
      await switchSession()
      continue
    }

    busy = true
    try {
      const tally = new PhaseTally()
      tally.reset()
      // Keterangan tool dicatat saat mulai; event tool-end hanya membawa nama.
      const previews = new Map<string, string>()
      // Jawaban dirender per baris lengkap. Selama baris belum lengkap tidak ada
      // yang tampil, jadi spinner menandakan Boo masih menulis.
      let answer: MarkdownRenderer | null = null
      let answerShown = false
      let waiting: NodeJS.Timeout | null = null

      const stopWaiting = () => {
        if (waiting) clearTimeout(waiting)
        waiting = null
      }
      const showAnswer = (output: string) => {
        if (!output) return
        status.clear()
        if (!answerShown) {
          emit('\n')
          answerShown = true
        }
        emit(output)
      }
      /** Menuntaskan baris dan blok jawaban yang tertahan sebelum hal lain tampil. */
      const finishAnswer = () => {
        if (!answer) return
        stopWaiting()
        showAnswer(answer.end())
        answer = null
        answerShown = false
      }

      // Argumen pemanggilan tool yang sedang digenerate, per indeks, per putaran model.
      const toolCalls = new Map<number, ToolCallProgress>()
      let lastToolActivity = ''

      for await (const event of agent.send(input)) {
        switch (event.type) {
          case 'turn-start':
            toolCalls.clear()
            lastToolActivity = ''
            status.activity(turnActivity(event.turn))
            break

          case 'reasoning':
            // Model thinking mengirim penalarannya lebih dulu; itu memang berpikir.
            if (!answer) status.activity('Thinking')
            break

          case 'tool-call': {
            // Argumen tool sedang digenerate — untuk write_file ini isi berkasnya.
            finishAnswer()
            let progress = toolCalls.get(event.index)
            if (!progress || progress.name !== event.name) {
              progress = new ToolCallProgress(event.name)
              toolCalls.set(event.index, progress)
            }
            progress.add(event.delta)
            const label = toolActivity(event.name)
            const detail = progress.describe()
            // Potongan argumen datang sangat rapat; status digambar ulang hanya bila isinya berubah.
            const key = `${event.index}|${label}|${detail}`
            if (key !== lastToolActivity) {
              lastToolActivity = key
              // Hitungan ringkasan dimulai ulang untuk setiap fase baru; tanpa ini
              // fase kedua ikut menghitung pekerjaan fase sebelumnya.
              if (status.currentPhase !== phaseOf(event.name)) tally.reset()
              status.work(phaseOf(event.name), label, detail)
            }
            break
          }

          case 'text': {
            if (!answer) {
              status.commit()
              answer = new MarkdownRenderer({ width: Math.min(stdout.columns || 100, MAX_ANSWER_WIDTH) })
            }
            stopWaiting()
            showAnswer(answer.push(event.delta))
            if (answer.hasPending) {
              const pending = answer
              waiting = setTimeout(() => {
                waiting = null
                if (answer === pending && pending.hasPending) status.activity('Generating')
              }, WAITING_INDICATOR_MS)
            }
            break
          }

          case 'tool-start': {
            finishAnswer()
            previews.set(event.callId, event.preview)
            if (status.currentPhase !== phaseOf(event.name)) tally.reset()
            status.work(phaseOf(event.name), toolActivity(event.name), describeArgs(event.name, event.args))
            break
          }

          case 'tool-end': {
            tally.record(event.name, event.isError, targetOf(previews.get(event.callId) ?? ''))
            const phase = phaseOf(event.name)
            status.update(phase === 'exploring' ? tally.exploring() : tally.applying())
            // Kegagalan tidak boleh disembunyikan di balik ringkasan.
            if (event.isError) {
              status.commit()
              emit(`  ${theme.danger('gagal')} ${theme.bold(event.name)}\n${summarize(event.content, 4)}\n`)
            } else if (VERBOSE) {
              status.commit()
              emit(`${summarize(event.content)}\n`)
            }
            break
          }

          case 'tool-denied':
            // Keputusannya sudah dicatat oleh panel izin. Fase yang dibuka hanya untuk
            // tool yang ditolak ini dibuang agar tidak membeku sebagai ringkasan kosong.
            status.discardEmpty()
            status.clear()
            break

          case 'turn-end':
            // Giliran berikutnya dimulai dengan model berpikir lagi. Kalimat
            // pengantar sebelum pemanggilan tool harus diakhiri dulu: spinner
            // menggambar dengan membersihkan barisnya dan akan menghapus kalimat itu.
            // Tool dijalankan berikutnya dan menampilkan labelnya sendiri.
            if (event.message.tool_calls?.length) finishAnswer()
            break

          case 'context-trimmed':
            status.clear()
            if (midLine) emit('\n')
            emit(`  ${theme.muted(`konteks dipangkas: ${event.droppedMessages} pesan lama dibuang (~${event.estimatedTokens} token terkirim)`)}\n`)
            break

          case 'error':
            status.clear()
            finishAnswer()
            emit(`\n  ${theme.danger('error')} ${event.message}\n`)
            break

          default:
            break
        }
      }
      finishAnswer()
      status.commit()
    } finally {
      // Ketikan yang belum dikirim tetap tersimpan di readline dan akan tampil lagi
      // bersama prompt berikutnya; keluaran yang ditahan dilepas lebih dulu.
      stopTyping(true)
      // Sibuk harus selalu dilepas; bila tersangkut, seluruh ketikan
      // berikutnya akan masuk antrean dan sesi tampak membeku.
      busy = false
    }
    stdout.write(midLine ? '\n\n' : '\n')
    midLine = false
  }

  readline.close()
  printResumeHint()
  console.log(`\n  ${theme.accent('Sampai jumpa.')}\n`)
}

await main()
