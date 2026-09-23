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
import { homedir } from 'node:os'
import {
  INIT_PROMPT,
  AttachmentError,
  inspectSandbox,
  acceptedEffort,
  aggregateLocalTraces,
  automaticReviewEnabled,
  Agent,
  DIFFICULTY_LABEL,
  FEATURED_FAMILIES,
  createDefaultRegistry,
  describeSelection,
  diffStats,
  evaluatePermission,
  findSelection,
  formatTaskStatus,
  formatProviderCapabilityProfile,
  formatFailurePostmortem,
  groupModels,
  loadInstructions,
  loadSkills,
  LocalRunTrace,
  MAX_AUTO_REVIEW_ROUNDS,
  PersistentRunJournal,
  designPrompt,
  listSpecs,
  findApp,
  launchApp,
  loadApps,
  nextTask,
  parseTodos,
  latestTodos,
  latestInterruptedRun,
  latestPlan,
  isImplementPlanRequest,
  expandPromptCommand,
  loadPromptCommands,
  loadHooks,
  loadPermissionPolicy,
  loadProviderCapabilityProfile,
  loadLatestFailurePostmortem,
  MAX_IMAGES_PER_MESSAGE,
  readSpec,
  revisePrompt,
  specPromptTitle,
  SPECS_DIRECTORY,
  taskPrompt,
  tasksPrompt,
  requirementsPrompt,
  reviewRequest,
  implementPlanRequest,
  planPromptTitle,
  planRequest,
  permissionRuleLabel,
  promptCommandTitle,
  referencedPromptTitle,
  uniqueSpecName,
  type SpecDocument,
  type SpecSummary,
  type SpecTask,
  todoProgress,
  NineRouterProvider,
  resolveShell,
  resolveConfiguredPermission,
  resolveSandboxPolicy,
  resolveInWorkspace,
  runCommand,
  splitUndoNote,
  storeImageFile,
  traceAgentEvents,
  journalAgentEvents,
  runRecoveryPrompt,
  tracingEnabled,
  type AgentOptions,
  type Compaction,
  type InstructionFile,
  type ImageAttachment,
  type Message,
  type ModelFamily,
  type ModelMode,
  type RepairResult,
  type UserAnswer,
  type UserQuestion,
  profilesFromConfig,
  type ProviderProfile,
  gatherQuota,
  providerLabel,
  type QuotaEntry,
} from '@boo/core'
import { GLOBAL_CONFIG_PATH, loadConfig } from '@boo/core/config/config.ts'
import { openBrowser, startWeb } from '@boo/web'
import { runSetup } from './setup.ts'
import { describeArgs, lastOutputLine, ToolCallProgress, toolActivity, turnActivity } from '@boo/core/presentation/activity.ts'
import { commandBody, describeRequest, diffBody, renderPanel, undoBody } from './approval.ts'
import { MarkdownRenderer } from './markdown.ts'
import { select } from './select.ts'
import { DISABLE_BRACKETED_PASTE, ENABLE_BRACKETED_PASTE, interceptPaste, isShiftEnter, MultilineInput, PasteStore } from './paste.ts'
import { renderTranscript } from './transcript.ts'
import {
  forkSession,
  forkSessionAt,
  listSessions,
  loadSession,
  relativeTime,
  sessionTurns,
  SessionError,
  SessionRecorder,
  shortId,
  type LoadedSession,
  type SessionSummary,
} from '@boo/core/session/sessions.ts'
import { PhaseTally, phaseOf, StatusLine } from './status.ts'
import { renderTodos } from './todos.ts'
import { banner, theme } from './theme.ts'
import { runExec } from './exec.ts'
import { diagnoseBoo, doctorExitCode, type DoctorConfig } from './doctor.ts'
import { runDaemon, runScheduleCommand } from './scheduler.ts'
import { runTriggerCommand } from './triggers.ts'
import { runNodeCommand } from './node.ts'

const DEFAULT_MODEL = 'ag/gemini-3.1-pro'

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

/**
 * Nama perintah yang ditampilkan di setiap petunjuk. `boo` tetap dapat dipakai,
 * tetapi petunjuk selalu menyebut satu nama resmi agar mudah disalin apa adanya.
 */
const COMMAND = 'boo-code'

const USAGE = `${COMMAND} — coding agent oleh FLdev

  ${COMMAND}                      mulai sesi di direktori saat ini
  ${COMMAND} <id>                 langsung buka sesi tertentu, misal: ${COMMAND} 5bd73640
  ${COMMAND} --resume             pilih sesi dari daftar
  ${COMMAND} --resume <id>        langsung buka sesi tertentu
  ${COMMAND} --continue           lanjutkan sesi terakhir di direktori ini
  ${COMMAND} exec [opsi] <prompt> jalankan satu tugas headless untuk script/CI
  ${COMMAND} web [--port N] [--no-open]
                  buka antarmuka web lokal
  ${COMMAND} web [--port <nomor>] buka antarmuka web lokal
  ${COMMAND} --model <id>         pilih model untuk sesi ini
  ${COMMAND} --model auto         pilih model dan penalaran otomatis per tugas
  ${COMMAND} --effort <tingkat>   low, medium, high, atau xhigh (model Codex)
  ${COMMAND} --sandbox <mode>     workspace-write, read-only, atau danger-full-access
  ${COMMAND} --verbose            tampilkan keluaran tool selengkapnya
  ${COMMAND} setup                siapkan alamat 9Router, kunci API, dan model bawaan
  ${COMMAND} doctor               periksa runtime, provider, sandbox, dan tool lokal
  ${COMMAND} schedule ...         kelola task agent terjadwal lokal
  ${COMMAND} trigger ...          kelola task berbasis event lokal
  ${COMMAND} daemon [--once]      jalankan scheduler dan event trigger
  ${COMMAND} node ...             pasangkan atau layani remote device
  ${COMMAND} --version            tampilkan versi
  ${COMMAND} --help               tampilkan bantuan ini

Prompt dapat memakai @path, @file:10-30, atau @"folder dengan spasi"
untuk menyertakan konteks workspace secara langsung.

Konfigurasi dibaca berlapis; yang belakangan menimpa yang sebelumnya:

  ${GLOBAL_CONFIG_PATH}
  <direktori kerja>/.env
  <direktori kerja>/.env.local
  environment variable

Isi minimal:

  NINEROUTER_URL=http://localhost:20128
  NINEROUTER_KEY=sk-...
  BOO_MODEL=auto
  BOO_EFFORT=medium`

const HELP = `  /model          pilih model dengan tombol panah
  /model auto     pilih model dan penalaran otomatis per permintaan
  /model <id> [tingkat]
                  ganti langsung, misal /model cx/gpt-5.6-sol xhigh
  /resume         pilih dan lanjutkan sesi lain di direktori ini
  /fork           cabangkan percakapan ini ke sesi eksperimen baru
  /rewind [nomor] buat cabang baru dari sebelum prompt lama
  /undo           batalkan perubahan berkas dari permintaan terakhir
  /limit          sisa limit tiap penyedia dan pemakaian model di mesin ini
  /restore [id]   pulihkan file ke sebelum checkpoint lama
  /commands       tampilkan custom command proyek dan global
  /hooks          tampilkan lifecycle hooks yang aktif
  /permissions    tampilkan aturan izin persisten dan lokasi konfigurasinya
  /attach <path>  lampirkan PNG/JPEG/WebP/GIF ke prompt berikutnya
  /attachments    lihat atau hapus attachment yang menunggu
  /plan <tugas>   selidiki dan buat rencana tanpa mengubah file
  /implement      kerjakan rencana terbaru dari /plan
  /spec <ide>     rancang fitur dulu: requirements, design, tasks
  /spec           lihat spec yang ada dan lanjutkan tahapnya
  /init           minta Boo menulis BOO.md berisi aturan proyek ini
  /compact        ringkas percakapan sejauh ini agar konteks lega
  /context        lihat pemakaian dan sumber konteks model
  /status         lihat tujuan, progres, file, tool, dan verifikasi task
  /capabilities   lihat capability model yang dipelajari Auto secara lokal
  /postmortem     jelaskan kegagalan task terakhir dari metadata lokal
  /review [base]  review perubahan tanpa mengedit file
  /stats          tampilkan metrik lokal 100 permintaan terakhir
  /doctor         periksa instalasi, provider, sandbox, dan integrasi opsional
  /apps           tampilkan aplikasi lokal yang terdaftar
  /open <alias>   buka aplikasi terdaftar (selalu meminta persetujuan)
  /run <perintah> jalankan perintah shell sekali ini (selalu meminta persetujuan)
  /queue          lihat task berikutnya yang mengantre
  /queue <task>   antrekan task baru, bukan arahan untuk pekerjaan aktif
  /queue hapus    kosongkan antrean
  /help           tampilkan bantuan ini
  /keluar         akhiri sesi

Dalam prompt, pakai @path, @file:10-30, atau @"folder dengan spasi"
untuk menyertakan konteks workspace secara langsung.
Mengetik selagi Boo bekerja menjadi arahan untuk pekerjaan aktif pada batas aman
berikutnya. Pakai /queue <task> bila ingin menjalankannya sebagai task terpisah.
Shift+Enter membuat baris baru; Enter mengirimkan permintaan.
Jika terminal tidak membedakan Shift+Enter, tekan Esc lalu Enter dengan cepat.
Esc atau Ctrl-C menghentikan pekerjaan yang sedang berjalan.

Aturan proyek dibaca dari BOO.md (atau AGENTS.md, CLAUDE.md) di workspace
dan induknya sampai akar repo, serta ~/.boo/BOO.md untuk semua proyek.`

function describeInstructions(files: readonly InstructionFile[]): string {
  return files.map((file) => file.label + (file.truncated ? ' (dipotong)' : '')).join(', ')
}

function shortDuration(milliseconds: number): string {
  return milliseconds < 1_000 ? `${Math.round(milliseconds)}ms` : `${(milliseconds / 1_000).toFixed(1)}s`
}

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
const VALUE_FLAGS = new Set(['--model', '-m', '--effort', '--sandbox', '--port', '-p'])

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
    fail(`Argumen tidak dikenal: ${positional.slice(1).join(' ')}`, `Pakai \`${COMMAND} <id>\` untuk membuka satu sesi, atau \`${COMMAND} --help\`.`)
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
        fail('Belum ada sesi tersimpan untuk direktori ini.', `Mulai sesi baru dengan \`${COMMAND}\`.`)
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
          fail('Terminal ini tidak mendukung pemilih.', `Jalankan \`${COMMAND} --resume <id>\` dengan id dari daftar di atas.`)
        }
        if (picked === null) {
          console.log(`  ${theme.muted('dibatalkan')}`)
          process.exit(0)
        }
        session = loadSession(summaries[picked].id)
      }
    }
  } catch (error) {
    if (error instanceof SessionError) fail(error.message, `Jalankan \`${COMMAND} --resume\` untuk memilih dari daftar sesi.`)
    throw error
  }

  if (session.workspace !== workspace) {
    fail(
      `Sesi ${shortId(session.id)} berasal dari ${session.workspace}.`,
      `Lanjutkan dari direktori itu:  cd ${session.workspace} && ${COMMAND} --resume ${shortId(session.id)}`,
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
    // Permintaan mode spec panjang dan disusun Boo; memanggilnya ulang tidak berguna.
    .filter((message) => message.role === 'user' && message.content && specPromptTitle(message.content) === null)
    .map((message) => {
      const text = splitUndoNote(message.content as string).text
      const visible = referencedPromptTitle(text) ?? text
      const plan = planPromptTitle(visible)
      if (plan !== null) return `/plan ${plan}`
      if (isImplementPlanRequest(visible)) return '/implement'
      const command = promptCommandTitle(visible)
      if (command !== null) return command
      return visible
    })
    .reverse()
}

/** Membaca nilai bendera seperti --model atau --effort dari argumen baris perintah. */
function flagValue(name: string, short?: string): string | undefined {
  const args = process.argv.slice(2)
  const index = args.findIndex((arg) => arg === `--${name}` || (short && arg === `-${short}`))
  if (index !== -1 && args[index + 1]) return args[index + 1]
  return args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
}

function webPort(): number | undefined {
  const value = flagValue('port', 'p')
  if (value === undefined) return undefined
  if (!/^\d+$/.test(value)) fail(`Port tidak sah: ${value}`, `Pakai nomor antara 0 dan 65535, misalnya \`${COMMAND} web --port 3000\`.`)
  const port = Number(value)
  if (port > 65_535) fail(`Port tidak sah: ${value}`, `Pakai nomor antara 0 dan 65535, misalnya \`${COMMAND} web --port 3000\`.`)
  return port
}

/**
 * Memastikan tingkat penalaran berlaku untuk model tersebut.
 *
 * Mengirim `reasoning_effort` ke model yang tidak menerimanya membuat upstream
 * menolak, dan 9Router lalu mengunci model itu beberapa puluh detik untuk semua
 * permintaan berikutnya. Karena itu tingkat yang tidak cocok dibuang di sini.
 */
function validEffort(model: string, effort: string | undefined): string | undefined {
  return acceptedEffort(model, effort)
}

/** Penyedia model yang dikonfigurasi; berhenti dengan petunjuk bila belum ada. */
function requireProviders(config: Record<string, string | undefined>): ProviderProfile[] {
  const profiles = profilesFromConfig(config)
  if (profiles.length) return profiles
  console.error(theme.danger('Belum ada penyedia model yang dikonfigurasi.'))
  console.error(theme.muted(`Jalankan ${COMMAND} setup, atau isi ${GLOBAL_CONFIG_PATH}:`))
  console.error(theme.muted('  NINEROUTER_URL=http://localhost:20128'))
  console.error(theme.muted('  NINEROUTER_KEY=sk-...  (dari Dashboard 9Router)'))
  console.error(theme.muted('Penyedia lain: OPENAI_API_KEY, ANTHROPIC_API_KEY, OPENROUTER_API_KEY, OLLAMA_BASE_URL, CUSTOM_API_URL.'))
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

async function showDoctor(workspace: string, config: DoctorConfig, sandboxStatus: ReturnType<typeof inspectSandbox>): Promise<number> {
  console.log(`\n  ${theme.accentBold('Boo Code doctor')}`)
  console.log(`  ${theme.muted('Tidak menampilkan kunci API, source, prompt, cookie, atau isi halaman.')}\n`)
  const checks = await diagnoseBoo({ workspace, config, configPath: GLOBAL_CONFIG_PATH, sandbox: sandboxStatus, platform: process.platform })
  for (const check of checks) {
    const mark = check.status === 'pass' ? theme.accent('✓') : check.status === 'warn' ? theme.removed('!') : theme.danger('✗')
    console.log(`  ${mark} ${check.label} · ${theme.muted(check.detail)}`)
  }
  const passed = checks.filter((check) => check.status === 'pass').length
  const warnings = checks.filter((check) => check.status === 'warn').length
  const failed = checks.filter((check) => check.status === 'fail').length
  console.log(`\n  ${failed ? theme.danger(`${failed} gagal`) : theme.accent(`${passed} lulus`)}${warnings ? theme.muted(` · ${warnings} peringatan`) : ''}\n`)
  return doctorExitCode(checks)
}

async function main() {
  if (process.argv[2] === 'exec') {
    process.exitCode = await runExec(process.argv.slice(3))
    return
  }
  if (process.argv[2] === 'schedule') {
    process.exitCode = await runScheduleCommand(process.argv.slice(3))
    return
  }
  if (process.argv[2] === 'trigger') {
    process.exitCode = await runTriggerCommand(process.argv.slice(3))
    return
  }
  if (process.argv[2] === 'daemon') {
    process.exitCode = await runDaemon(process.argv.slice(3))
    return
  }
  if (process.argv[2] === 'node') {
    process.exitCode = await runNodeCommand(process.argv.slice(3))
    return
  }
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(USAGE)
    return
  }
  if (process.argv.includes('--version') || process.argv.includes('-V')) {
    console.log(version())
    return
  }

  const workspace = process.cwd()
  let config = loadConfig(workspace)
  const setupDefaults = () => ({ url: config.NINEROUTER_URL, key: config.NINEROUTER_KEY, model: config.BOO_MODEL, config })
  if (process.argv[2] === 'setup') {
    process.exit(await runSetup(setupDefaults()) ? 0 : 1)
  }
  if (process.argv[2] === 'doctor') {
    const policy = resolveSandboxPolicy(flagValue('sandbox') || config.BOO_SANDBOX, config.BOO_NETWORK_ACCESS)
    process.exitCode = await showDoctor(workspace, config, inspectSandbox(workspace, policy))
    return
  }
  // Pertama kali dijalankan di mesin ini: tawarkan setup, bukan pesan error.
  if (!profilesFromConfig(config).length && stdin.isTTY) {
    console.log(`\n  ${theme.muted('Boo Code belum dikonfigurasi di mesin ini.')}`)
    if (!await runSetup(setupDefaults())) process.exit(1)
    config = loadConfig(workspace)
  }
  if (process.argv[2] === 'web') {
    requireProviders(config)
    const running = await startWeb({ workspace, config: { ...config, BOO_MODEL: flagValue('model', 'm') || config.BOO_MODEL, BOO_EFFORT: flagValue('effort') || config.BOO_EFFORT, BOO_SANDBOX: flagValue('sandbox') || config.BOO_SANDBOX }, version: version(), port: webPort() })
    console.log(`\n  ${theme.accentBold('Boo Code web')} berjalan untuk ${workspace}`)
    console.log(`  ${theme.muted('Buka di browser:')} ${running.server.openUrl}`)
    console.log(`  ${theme.muted('Tekan Ctrl-C untuk menghentikan server.')}\n`)
    // Di server tanpa layar, atau saat dijalankan dari skrip, browser tidak dibuka.
    if (!process.argv.includes('--no-open')) openBrowser(running.server.openUrl)
    let closing = false
    const close = async () => {
      if (closing) return
      closing = true
      await running.close()
      process.exit(0)
    }
    process.once('SIGINT', () => { void close() })
    process.once('SIGTERM', () => { void close() })
    return
  }
  const resumed = await resolveResume(resumeRequest(), workspace)
  const sandbox = resolveSandboxPolicy(flagValue('sandbox') || config.BOO_SANDBOX, config.BOO_NETWORK_ACCESS)

  // Urutan prioritas: bendera baris perintah, lalu model terakhir sesi yang
  // dilanjutkan, lalu konfigurasi, lalu bawaan.
  const flagModel = flagValue('model', 'm')
  const fromSession = !flagModel && Boolean(resumed?.model)
  let modelMode: ModelMode = flagModel ? (flagModel === 'auto' ? 'auto' : 'manual')
    : resumed ? resumed.modelMode ?? 'manual' : config.BOO_MODEL && config.BOO_MODEL !== 'auto' ? 'manual' : 'auto'
  const requestedModel = flagModel || resumed?.model || config.BOO_MODEL || DEFAULT_MODEL
  const model = requestedModel === 'auto' ? resumed?.model || DEFAULT_MODEL : requestedModel
  const requestedEffort = flagValue('effort') || (fromSession ? resumed?.reasoningEffort : config.BOO_EFFORT)
  const reasoningEffort = modelMode === 'auto' ? undefined : validEffort(model, requestedEffort)
  if (modelMode === 'manual' && requestedEffort && !reasoningEffort) {
    console.error(theme.muted(`Tingkat "${requestedEffort}" tidak berlaku untuk ${model}; diabaikan.`))
  }

  const profiles = requireProviders(config)
  const provider = new NineRouterProvider({
    baseUrl: config.NINEROUTER_URL || DEFAULT_BASE_URL,
    apiKey: config.NINEROUTER_KEY ?? '',
    profiles,
    model,
    reasoningEffort,
    home: homedir(),
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

  const status = new StatusLine(emit, 'esc untuk berhenti')

  /** Pekerjaan yang sedang berjalan; dibatalkan oleh Esc atau Ctrl-C. */
  let currentRequest: AbortController | null = null

  /**
   * Menghentikan pekerjaan yang sedang berjalan. Koneksi ke model diputus, perintah
   * shell dihentikan, dan agent merapikan riwayat sehingga permintaan berikutnya
   * tetap sah. Antrean tidak dikosongkan: mengetik koreksi lalu menekan Esc membuat
   * koreksi itu langsung dikerjakan.
   */
  function cancelWork(): boolean {
    if (!currentRequest || currentRequest.signal.aborted) return false
    currentRequest.abort()
    status.activity('Stopping')
    return true
  }

  // Dapat diganti oleh /resume; setiap penutup membaca nilai terkini lewat binding ini.
  let recorder = new SessionRecorder({ workspace, model, reasoningEffort, modelMode, resumeId: resumed?.id })
  /** Attachment ditahan sampai prompt pengguna berikutnya benar-benar dikirim. */
  const pendingImages: ImageAttachment[] = []
  // Bendera --model atau --effort saat melanjutkan mengganti model sesi itu.
  if (resumed && (model !== resumed.model || reasoningEffort !== resumed.reasoningEffort)) {
    recorder.recordModel(model, reasoningEffort)
  }
  if (resumed && modelMode !== (resumed.modelMode ?? 'manual')) recorder.recordModelMode(modelMode)

  function printResumeHint(): void {
    if (!recorder.started) return
    console.log(`\n  ${theme.muted('Lanjutkan sesi ini:')} ${COMMAND} --resume ${shortId(recorder.id)}`)
  }

  // Ctrl-C pertama menutup sesi dengan tertib; bila Boo masih bekerja, pekerjaan
  // itu diselesaikan dulu. Ctrl-C kedua keluar seketika — aman, karena setiap pesan
  // sudah ditulis ke berkas sesi begitu masuk ke riwayat.
  // Ctrl-C saat Boo bekerja menghentikan pekerjaannya, seperti Esc. Ctrl-C lagi
  // selagi berhenti, atau Ctrl-C saat diam, keluar dari sesi. Keluar selalu aman
  // karena setiap pesan sudah tersimpan begitu masuk ke riwayat.
  let interrupted = false
  readline.on('SIGINT', () => {
    if (busy && cancelWork()) return
    if (interrupted || busy) {
      status.clear()
      printResumeHint()
      process.exit(130)
    }
    interrupted = true
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
    if (argument) {
      pending.push(argument)
      console.log(`  ${theme.muted(`task #${pending.length} ditambahkan ke antrean`)}\n`)
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

  const pastes = new PasteStore()
  const multiline = new MultilineInput()
  let continueWithNewline = false
  readline.on('line', (typed) => {
    // Penanda tempelan banyak baris dikembalikan menjadi isi aslinya.
    const expanded = pastes.expand(typed)
    if (continueWithNewline) {
      continueWithNewline = false
      multiline.continue(expanded)
      return
    }
    const line = multiline.submit(expanded)
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
      try {
        const position = agent.steer(text)
        if (position) {
          status.note(`  ${theme.accent('↳')} ${theme.muted(`arahan diterima #${position}  ${typed.trim()}`)}`)
          return
        }
      } catch (error) {
        status.note(`  ${theme.danger('!')} ${theme.muted(error instanceof Error ? error.message : 'Arahan tidak dapat diterima.')}`)
        return
      }
      pending.push(text)
      status.note(`  ${theme.muted(`antre #${pending.length}  ${typed.trim()}`)}`)
      return
    }
    buffered.push(line)
  })
  readline.on('close', () => {
    ended = true
    multiline.clear()
    while (waiting.length) waiting.shift()?.(null)
  })

  // Spinner dan ketikan berbagi satu baris. Begitu pengguna menekan tombol saat
  // Boo bekerja, animasi dihentikan agar readline memiliki barisnya sendiri.
  if (stdin.isTTY) {
    // Harus dipasang sebelum pendengar lain: hanya pendengar readline yang dibungkus.
    interceptPaste(stdin, (text) => readline.write(pastes.insert(text)))
    stdout.write(ENABLE_BRACKETED_PASTE)
    process.on('exit', () => stdout.write(DISABLE_BRACKETED_PASTE))
    // Dipasang di depan pendengar readline, sehingga baris ketik sudah punya
    // tempat sendiri sebelum readline menggemakan huruf pertama.
    stdin.prependListener('keypress', (_: string, key: { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean; sequence?: string } = {}) => {
      if (isShiftEnter(key)) {
        // Untuk Return biasa Node readline sudah mengakhiri barisnya sendiri.
        // CSI kitty tidak dikenali readline, sehingga baris itu diakhiri manual.
        continueWithNewline = true
        if (key.name !== 'return' && key.name !== 'enter') {
          readline.write(null, { name: 'return', ctrl: false, meta: false, shift: false, sequence: '\r' })
        }
        return
      }
      if (!busy) return
      if (key.name === 'escape') {
        cancelWork()
        return
      }
      if (typing) return
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

  function showApps(): void {
    const catalog = loadApps(workspace)
    if (!catalog.apps.length) {
      console.log(`\n  ${theme.muted('Belum ada aplikasi terdaftar. Tambahkan ~/.boo/apps.json atau .boo/apps.json di workspace.')}\n`)
    } else {
      console.log(`\n  ${theme.bold('Aplikasi lokal yang diizinkan:')}`)
      for (const app of catalog.apps) console.log(`  ${theme.accent(app.id)}  ${app.label}`)
      console.log(`\n  ${theme.muted('Buka dengan: /open <alias>')}\n`)
    }
    for (const issue of catalog.issues) console.log(`  ${theme.danger('!')} ${theme.muted(issue)}`)
  }

  function showCommands(): void {
    const commands = loadPromptCommands({ workspace, home: homedir() })
    if (!commands.length) {
      console.log(`\n  ${theme.muted('Belum ada custom command. Tambahkan .boo/commands/<nama>.md atau ~/.boo/commands/<nama>.md.')}\n`)
      return
    }
    console.log(`\n  ${theme.bold('Custom commands:')}`)
    for (const command of commands) console.log(`  ${theme.accent(`/${command.name}`)}  ${command.description} ${theme.muted(`[${command.source}]`)}`)
    console.log('')
  }

  function showHooks(): void {
    const hooks = loadHooks(workspace, homedir())
    if (!hooks.length) {
      console.log(`\n  ${theme.muted('Belum ada lifecycle hook. Tambahkan .boo/hooks.json atau ~/.boo/hooks.json.')}\n`)
      return
    }
    console.log(`\n  ${theme.bold('Lifecycle hooks:')}`)
    for (const hook of hooks) console.log(`  ${theme.accent(`${hook.event}:${hook.id}`)}  ${hook.matcher} → ${hook.command} ${theme.muted(`[${hook.source}]`)}`)
    console.log('')
  }

  function showPermissions(): void {
    const policy = loadPermissionPolicy({ workspace, home: homedir() })
    console.log(`\n  ${theme.bold('Aturan izin persisten:')}`)
    if (!policy.rules.length) console.log(`  ${theme.muted('(belum ada aturan aktif)')}`)
    for (const rule of policy.rules) {
      const marker = rule.effect === 'allow' ? theme.accent('✓') : rule.effect === 'deny' ? theme.danger('✗') : theme.muted('?')
      console.log(`  ${marker} ${permissionRuleLabel(rule)}`)
    }
    for (const issue of policy.issues) console.log(`  ${theme.danger('!')} ${theme.muted(issue)}`)
    console.log(`\n  ${theme.muted(`Pribadi (allow/ask/deny): ${policy.globalPath}`)}`)
    console.log(`  ${theme.muted(`Proyek (ask/deny saja): ${policy.projectPath}`)}`)
    console.log(`  ${theme.muted('Format: { "version": 1, "rules": [{ "id": "tests", "effect": "allow", "tool": "bash", "command": "pnpm test" }] }')}\n`)
  }

  function attachImage(rawPath: string): void {
    if (!rawPath.trim()) {
      console.log(`  ${theme.muted('Pakai: /attach <path-gambar>. Path dengan spasi boleh diapit tanda kutip.')}`)
      return
    }
    if (pendingImages.length >= MAX_IMAGES_PER_MESSAGE) {
      console.log(`  ${theme.danger(`Maksimal ${MAX_IMAGES_PER_MESSAGE} gambar untuk satu prompt.`)}`)
      return
    }
    const trimmed = rawPath.trim()
    const path = (((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))
      ? trimmed.slice(1, -1)
      : trimmed).replace(/\\([\\ "'()&])/g, '$1')
    try {
      const image = storeImageFile(path, { sessionId: recorder.id, home: homedir() })
      pendingImages.push(image)
      console.log(`  ${theme.accent('✓')} ${theme.muted(`${image.name} dilampirkan (${Math.ceil(image.bytes / 1024)} KiB) · kirim bersama prompt berikutnya`)}`)
    } catch (error) {
      console.log(`  ${theme.danger(error instanceof AttachmentError || error instanceof Error ? error.message : 'Gambar tidak dapat dilampirkan.')}`)
    }
  }

  function showAttachments(argument: string): void {
    if (argument === 'hapus' || argument === 'clear') {
      const count = pendingImages.length
      pendingImages.length = 0
      console.log(`  ${theme.muted(`${count} attachment dilepas dari prompt berikutnya.`)}`)
      return
    }
    if (!pendingImages.length) {
      console.log(`  ${theme.muted('Tidak ada attachment yang menunggu. Gunakan /attach <path-gambar>.')}`)
      return
    }
    console.log(`  ${theme.bold('Attachment prompt berikutnya:')}`)
    pendingImages.forEach((image, index) => console.log(`  ${index + 1}. ${image.name} ${theme.muted(`(${Math.ceil(image.bytes / 1024)} KiB)`)}`))
    console.log('')
  }

  async function confirmOnce(question: string): Promise<boolean> {
    const choice = await select(readline, {
      title: question,
      items: ['Ya, jalankan', 'Tidak, batalkan'],
      initialIndex: 1,
      numbered: true,
      hint: 'panah memilih · enter memakai · esc membatalkan',
    })
    if (choice === null) return false
    if (choice !== undefined) return choice === 0
    return (await ask(`  ${question} [y/N] `))?.trim().toLowerCase() === 'y'
  }

  async function openRegisteredApp(id: string): Promise<void> {
    const catalog = loadApps(workspace)
    const app = findApp(catalog, id)
    if (!app) {
      console.log(`  ${theme.danger(`Aplikasi "${id}" tidak terdaftar. Jalankan /apps untuk melihat alias yang tersedia.`)}`)
      return
    }
    if (!await confirmOnce(`Buka aplikasi ${app.label}?`)) {
      console.log(`  ${theme.muted('dibatalkan')}`)
      return
    }
    try {
      await launchApp(app, workspace)
      console.log(`  ${theme.accent('✓')} ${theme.muted(`${app.label} sedang dibuka`)}`)
    } catch (error) {
      console.log(`  ${theme.danger(`Gagal membuka ${app.label}: ${error instanceof Error ? error.message : 'kesalahan tidak dikenal'}`)}`)
    }
  }

  async function runDirectCommand(command: string): Promise<void> {
    if (!command) {
      console.log(`  ${theme.muted('Pakai: /run <perintah>. Contoh: /run git status')}`)
      return
    }
    if (!await confirmOnce(`Jalankan perintah ini?\n  ${command}`)) {
      console.log(`  ${theme.muted('dibatalkan')}`)
      return
    }
    const result = await runCommand(command, { cwd: workspace, shell: resolveShell(), sandbox, timeoutMs: 120_000 })
    if (result.cancelled) console.log(`  ${theme.danger('Perintah dibatalkan.')}`)
    else if (result.timedOut) console.log(`  ${theme.danger('Waktu perintah habis setelah 120 detik.')}`)
    else if (result.spawnError || result.exitCode !== 0) console.log(`  ${theme.danger(`Perintah gagal: ${result.spawnError ?? `exit ${result.exitCode ?? '?'}`}`)}`)
    if (result.output) console.log(`\n${result.output}\n`)
  }

  function showLocalStats(): void {
    const stats = aggregateLocalTraces(homedir(), workspace, 100)
    if (!stats.runs) {
      console.log(`  ${theme.muted('Belum ada trace lokal untuk workspace ini.')}`)
      return
    }
    const models = Object.entries(stats.models).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, count]) => `${name} ${count}×`).join(', ')
    const tools = Object.entries(stats.tools).sort((a, b) => b[1].calls - a[1].calls).slice(0, 5).map(([name, metric]) => `${name} ${metric.calls}×`).join(', ')
    const failures = Object.entries(stats.failureCategories).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, count]) => `${name} ${count}×`).join(', ')
    console.log(`\n  ${theme.bold(`Metrik lokal · ${stats.runs} run terakhir`)}`)
    console.log(`  selesai ${stats.completed} · dibatalkan ${stats.cancelled} · berhenti ${stats.stopped} · error ${stats.errors}`)
    console.log(`  rata-rata ${shortDuration(stats.averageDurationMs)} · ${stats.averageTurns} turn · ${stats.averageToolCalls} tool call`)
    console.log(`  kegagalan tool ${stats.toolFailureRate}% · verifikasi belum tuntas ${stats.verificationIncomplete}`)
    console.log(`  verification repair ${stats.verificationRepairRounds} putaran · ${stats.verificationRepairs} pulih · ${stats.verificationRepairExhausted} kehabisan batas`)
    console.log(`  change impact ${stats.changeImpactAnalyses} analisis · ${stats.changeImpactAffectedFiles} file · ${stats.changeImpactEdges} relasi · ${stats.changeImpactLarge} blast radius besar`)
    console.log(`  LSP session ${stats.lspSessionStarts} baru · ${stats.lspSessionReuses} reuse · ${stats.lspSessionRestarts} restart`)
    console.log(`  review otomatis ${stats.criticReviews} · temuan ${stats.criticFindings} · gagal ${stats.criticFailures} · risiko tinggi ${stats.highRiskRuns} · arahan live ${stats.steeringMessages}`)
    console.log(`  evidence cache ${stats.evidenceCacheHits} hit · ${stats.evidenceCacheSavedCharacters.toLocaleString('id-ID')} karakter dihemat · context relevance ${stats.contextPrioritizedMessages} pesan`)
    console.log(`  context dependency ${stats.contextDependencyMessages} pesan · ${stats.contextDependencyEdges} relasi`)
    console.log(`  parallel discovery ${stats.parallelDiscoveryCalls} call · ${stats.parallelDiscoveryBatches} batch`)
    console.log(`  tool result store ${stats.truncatedToolResults} hasil besar · ${stats.deferredToolResultCharacters.toLocaleString('id-ID')} karakter ditahan`)
    console.log(`  timeout recovery ${stats.toolTimeoutRecoveries}`)
    if (failures) console.log(`  postmortem: ${failures}`)
    if (models) console.log(`  model: ${models}`)
    if (tools) console.log(`  tool: ${tools}`)
    console.log(`  ${theme.muted('Hanya metrik; prompt, kode, argumen, dan output tidak direkam.')}\n`)
  }

  function showContextUsage(): void {
    const report = agent.contextReport()
    const number = (value: number) => value.toLocaleString('id-ID')
    const width = 24
    const filled = Math.min(width, Math.max(0, Math.round(report.usagePercent / 100 * width)))
    const bar = `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`
    const state = report.pressure === 'healthy'
      ? theme.accent('aman')
      : report.pressure === 'attention' ? theme.removed('perlu perhatian') : theme.danger('kritis')
    console.log(`\n  ${theme.bold('Konteks model')} · ${state}`)
    console.log(`  ${bar}  ${report.usagePercent}%`)
    console.log(`  dikirim ${number(report.sentTokens)} / ${number(report.limitTokens)} token · ruang ${number(report.headroomTokens)}`)
    console.log(`  system ${number(report.breakdown.system)} · pengguna ${number(report.breakdown.user)} · jawaban ${number(report.breakdown.assistant)}`)
    console.log(`  hasil tool ${number(report.breakdown.toolResults)} · panggilan tool ${number(report.breakdown.toolCalls)} · skema tool ${number(report.breakdown.toolSchemas)} · gambar ${number(report.breakdown.images)}`)
    console.log(`  riwayat ${report.historyMessages} pesan · konteks aktif ${report.messages} pesan · dikirim ${report.sentMessages} pesan`)
    if (report.compactionActive) console.log(`  ${theme.muted(`${report.summarizedMessages} pesan lama sudah diganti ringkasan otomatis.`)}`)
    if (report.droppedMessages) {
      console.log(`  ${theme.danger(`${report.droppedMessages} pesan tidak muat; ${report.prioritizedMessages} pesan lama relevan akan dipertahankan.`)}`)
      if (report.dependencyMessages) console.log(`  ${theme.muted(`${report.dependencyMessages} pesan dependency dipertahankan melalui ${report.dependencyEdges} relasi context.`)}`)
    }
    else if (report.pressure !== 'healthy') console.log(`  ${theme.muted('Gunakan /compact sekarang bila ingin memberi ruang sebelum task besar berikutnya.')}`)
    else console.log(`  ${theme.muted('Belum perlu compact; Boo akan meringkas otomatis saat mendekati batas.')}`)
    console.log()
  }

  async function showTaskStatus(): Promise<void> {
    const report = formatTaskStatus(await agent.taskStatus())
    console.log(`\n  ${theme.bold('Status task')}`)
    for (const line of report.split('\n')) console.log(`  ${line}`)
    console.log()
  }

  const ESC = String.fromCharCode(27)
  /**
   * Izin yang diberikan untuk sisa sesi lewat pilihan kedua panel. Perubahan berkas
   * disetujui sebagai satu kelompok, tetapi perintah shell hanya per perintah persis:
   * menyetujui `pnpm test` tidak boleh ikut meloloskan perintah lain.
   */
  const sessionApprovals = new Set<string>()
  function approvalKeyOf(kind: string, tool: string, command: string, appId: string): string {
    if (kind === 'edit') return 'edit'
    if (kind === 'command') return `command:${command}`
    if (tool === 'open_app') return `app:${appId}`
    return `tool:${tool}`
  }
  function recordDecision(allowed: boolean, text: string): void {
    emit(`  ${allowed ? theme.accent('✓') : theme.danger('✗')} ${theme.muted(text)}\n`)
  }

  const agentOptions: Omit<AgentOptions, 'history' | 'onMessage'> = {
    async onTurnLimit(turns) {
      stopTyping(true)
      // Pekerjaan sejauh ini dibekukan dulu, agar pertanyaannya tampil sesudahnya.
      status.commit()
      if (midLine) emit('\n')
      const question = `Boo sudah ${turns} langkah mengerjakan permintaan ini. Lanjutkan?`
      const choice = await select(readline, {
        title: question,
        items: ['Ya, lanjutkan', 'Tidak, berhenti di sini'],
        initialIndex: 0,
        numbered: true,
        hint: 'panah memilih · enter memakai · esc berhenti',
      })
      const proceed = choice === undefined
        // Terminal tanpa raw mode: jawaban kosong berarti lanjut.
        ? (await ask(`  ${question} [Y/n] `))?.trim().toLowerCase() !== 'n'
        : choice === 0
      recordDecision(proceed, proceed ? `lanjut setelah ${turns} langkah` : `berhenti setelah ${turns} langkah`)
      return proceed
    },
    async askUser(question: UserQuestion): Promise<UserAnswer> {
      stopTyping(true)
      status.commit()
      if (midLine) emit('\n')
      const options = question.options.map((option) => option.description ? `${option.label} — ${option.description}` : option.label)
      if (question.allowCustom) options.push('Jawaban lain…')
      const choice = await select(readline, {
        title: `${question.header ? `${question.header} · ` : ''}${question.question}`,
        items: options,
        initialIndex: 0,
        numbered: true,
        hint: 'panah memilih · enter memakai · esc melewati',
      })
      if (choice === null) return { cancelled: true }
      if (choice === undefined) {
        emit(`\n  ${theme.bold(question.question)}\n`)
        question.options.forEach((option, index) => emit(`  ${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ''}\n`))
        if (question.allowCustom) emit(`  ${question.options.length + 1}. Jawaban lain\n`)
        const raw = (await ask(`  Pilihan 1-${options.length}${question.allowCustom ? ' atau ketik jawaban' : ''}: `))?.trim() ?? ''
        const picked = /^\d+$/.test(raw) ? Number(raw) - 1 : -1
        if (picked >= 0 && picked < question.options.length) {
          const selected = question.options[picked].label
          recordDecision(true, `Jawaban · ${question.header ? `${question.header}: ` : ''}${selected}`)
          return { selected }
        }
        if (question.allowCustom && raw && picked === -1) {
          recordDecision(true, `Jawaban · ${question.header ? `${question.header}: ` : ''}${raw}`)
          return { text: raw }
        }
        if (question.allowCustom && picked === question.options.length) {
          const text = (await ask(`  ${theme.accent('✎')} Jawaban: `))?.trim() ?? ''
          if (text) {
            recordDecision(true, `Jawaban · ${question.header ? `${question.header}: ` : ''}${text}`)
            return { text }
          }
        }
        return { cancelled: true }
      }
      if (choice < question.options.length) {
        const selected = question.options[choice].label
        recordDecision(true, `Jawaban · ${question.header ? `${question.header}: ` : ''}${selected}`)
        return { selected }
      }
      const text = (await ask(`  ${theme.accent('✎')} ${theme.bold('Jawaban:')} `))?.trim() ?? ''
      if (!text) return { cancelled: true }
      recordDecision(true, `Jawaban · ${question.header ? `${question.header}: ` : ''}${text}`)
      return { text }
    },
    provider,
    registry: createDefaultRegistry(),
    workspace,
    home: homedir(),
    autoReview: automaticReviewEnabled(config.BOO_AUTO_REVIEW),
    sandbox,
    instructions: (targets) => loadInstructions({ workspace, home: homedir(), targets }),
    skills: () => loadSkills({ workspace, home: homedir() }),
    hooks: () => loadHooks(workspace, homedir()),
    ...(Number(config.BOO_MAX_TURNS) > 0 ? { maxTurns: Number(config.BOO_MAX_TURNS) } : {}),
    ...(config.BOO_MAX_CONTEXT_TOKENS
      ? { maxContextTokens: Number(config.BOO_MAX_CONTEXT_TOKENS) }
      : {}),
    async askPermission({ name, args, detail, allowAlways, promptInjectionRisk }) {
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
      const appId = typeof args.id === 'string' ? args.id : ''
      const approvalKey = approvalKeyOf(request.kind, name, command, appId)
      // Catatan keputusan memuat apa yang benar-benar disetujui: perintahnya, bukan
      // deskripsi yang ditulis model tentang perintah itu.
      const summary = request.kind === 'command'
        ? `${request.title} · ${command}`
        : request.subject ? `${request.title} ${request.subject}` : request.title

      const configured = evaluatePermission(loadPermissionPolicy({ workspace, home: homedir() }), { tool: name, args })
      if (configured?.effect === 'deny') {
        const feedback = `Aturan izin ${configured.rule.id} menolak tindakan ini.`
        recordDecision(false, `${summary} · ditolak oleh ${configured.rule.id} [${configured.rule.source}]`)
        return { allowed: false, feedback }
      }
      const configuredEffect = resolveConfiguredPermission(configured, {
        allowAlways,
        commandAction: request.kind === 'command',
        sandbox: sandboxStatus,
      })
      if (configuredEffect === 'allow') {
        recordDecision(true, `${summary} · diizinkan oleh ${configured!.rule.id} [${configured!.rule.source}]`)
        return true
      }
      // `ask` memaksa dialog walaupun tindakan serupa sudah diizinkan untuk sesi.
      // Allow untuk aksi fresh-approval atau command tanpa sandbox juga turun ke ask.
      const forceAsk = configuredEffect === 'ask'

      if (!forceAsk && allowAlways && sessionApprovals.has(approvalKey)) {
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

      const choices = allowAlways
        ? ['Ya', request.allowAlways, 'Tidak, beri tahu Boo apa yang harus dilakukan']
        : ['Ya', 'Tidak, beri tahu Boo apa yang harus dilakukan']
      const approvalQuestion = promptInjectionRisk
        ? `Sinyal prompt injection aktif; periksa tindakan ini secara mandiri. ${request.question}`
        : request.question
      const choice = await select(readline, {
        title: approvalQuestion,
        items: choices,
        initialIndex: 0,
        numbered: true,
        hint: allowAlways ? 'panah memilih · enter memakai · 1-3 pintasan · esc menolak' : 'panah memilih · enter memakai · 1-2 pintasan · esc menolak',
      })

      if (choice === undefined) {
        // Terminal tanpa raw mode: panel tetap tampil dan jawabannya diketik.
        const answer = await ask(`  ${approvalQuestion} [y/N] `)
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
      if (allowAlways && choice === 1) {
        sessionApprovals.add(approvalKey)
        const scope = request.kind === 'edit' ? 'semua perubahan berkas' : request.kind === 'command' ? 'perintah ini' : name
        recordDecision(true, `${summary} · ${scope} diizinkan untuk sisa sesi`)
        return true
      }
      if (choice === (allowAlways ? 2 : 1)) {
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
  function createAgent(history: Message[] | undefined, compaction?: Compaction): Agent {
    const recovery = history ? latestInterruptedRun(homedir(), workspace, recorder.id) : null
    return new Agent({
      ...agentOptions,
      modelMode,
      sessionId: recorder.id,
      ...(recovery ? { recoveryPrompt: runRecoveryPrompt(recovery, latestTodos(history ?? []), history ?? []) } : {}),
      history,
      ...(compaction ? { compaction } : {}),
      onMessage: (message) => recorder.recordMessage(message),
      onCompaction: (summary) => recorder.recordCompaction(summary),
    })
  }
  let agent = createAgent(resumed?.messages, resumed?.compaction)

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
    modelMode = 'manual'
    agent.setModelMode(modelMode)
    recorder.recordModelMode(modelMode)
    provider.model = modelId
    // Selalu ditimpa, termasuk menjadi undefined: tingkat milik model sebelumnya
    // tidak boleh terbawa ke model yang tidak menerimanya.
    provider.reasoningEffort = effort
    recorder.recordModel(modelId, effort)
    console.log(`  ${theme.accent('model')} ${theme.bold(describeSelection(families, modelId, effort))}\n`)
  }

  function applyAuto(): void {
    modelMode = 'auto'
    agent.setModelMode(modelMode)
    recorder.recordModelMode(modelMode)
    console.log(`  ${theme.accent('model')} ${theme.bold('Auto · model dan penalaran mengikuti kesulitan tugas')}\n`)
  }

  function currentModelLabel(): string {
    const label = modelLabel(provider.model, provider.reasoningEffort)
    return modelMode === 'auto' ? `Auto · ${agent.lastAutoSelection ? label : 'menunggu tugas'}` : `Manual · ${label}`
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
      if (modelId.toLowerCase() === 'auto') {
        if (effort) console.log(`  ${theme.danger('Auto menentukan tingkat penalaran sendiri.')}\n`)
        else applyAuto()
        return
      }
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
      console.log(`  ${theme.muted('Daftar model tidak dapat dimuat; Auto tetap bisa dipilih.')} ${error instanceof Error ? error.message : 'gagal'}\n`)
      families = []
    }

    const featured = FEATURED_FAMILIES
      .map((key) => families.find((family) => family.key === key))
      .filter((family): family is ModelFamily => Boolean(family))
    const others = families.filter((family) => !featured.includes(family))
    const current = findSelection(families, provider.model, provider.reasoningEffort)

    // Langkah 1: keluarga unggulan, dengan model lain dilipat di bawahnya.
    const firstPage = ['Auto · sesuai kesulitan tugas', ...featured.map((f) => f.label), ...(others.length ? [OTHER_MODELS_LABEL] : [])]
    const currentInFeatured = current ? featured.indexOf(current.family) : -1
    const firstActive = modelMode === 'auto' ? 0 : currentInFeatured !== -1 ? currentInFeatured + 1 : current && others.length ? featured.length + 1 : -1
    const firstPick = await choose('Pilih model', firstPage, firstActive)
    if (firstPick === null) {
      console.log(`  ${theme.muted('dibatalkan')}\n`)
      return
    }
    if (firstPick === 0) { applyAuto(); return }

    let family: ModelFamily
    if (firstPick === featured.length + 1) {
      const otherActive = current ? others.indexOf(current.family) : -1
      const otherPick = await choose('Model lain', others.map((f) => f.label), otherActive)
      if (otherPick === null) {
        console.log(`  ${theme.muted('dibatalkan')}\n`)
        return
      }
      family = others[otherPick]
    } else {
      family = featured[firstPick - 1]
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
  console.log(`  ${theme.accent('Boo Code')} ${theme.muted(`· ${currentModelLabel()} · ${workspace}`)}`)
  if (agent.instructions.length) console.log(`  ${theme.muted(`aturan proyek: ${describeInstructions(agent.instructions)}`)}`)
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
    const interrupted = latestInterruptedRun(homedir(), workspace, session.id)
    if (interrupted) {
      const recoveryDetails = [
        interrupted.activeTools.length ? `${interrupted.activeTools.join(', ')} belum pasti selesai` : '',
        interrupted.checkpoint?.files.length ? `${interrupted.checkpoint.files.length} file perlu diperiksa` : '',
        interrupted.verificationNeeded ? 'verifikasi tertunda' : '',
      ].filter(Boolean)
      notes.push(`run terputus pada langkah ${Math.max(1, interrupted.lastTurn + 1)}${recoveryDetails.length ? ` (${recoveryDetails.join('; ')})` : ''}`)
    }
    if (notes.length) console.log(`\n  ${theme.muted(`sesi sebelumnya berhenti mendadak: ${notes.join(', ')}`)}`)
    console.log()
  }

  /**
   * Berpindah ke sesi lain tanpa keluar dari boo. Sesi yang sedang berjalan sudah
   * tersimpan pesan demi pesan, jadi tidak ada yang hilang saat ditinggalkan.
   */
  /** Mengembalikan berkas yang diubah Boo pada permintaan terakhir yang mengubah berkas. */
  /** Jam pulihnya jatah, atau "—" bila tidak diketahui. */
  function whenResets(resetAt: number | undefined): string {
    if (!resetAt) return '—'
    const minutes = Math.round((resetAt - Date.now()) / 60_000)
    if (minutes <= 0) return 'sebentar lagi'
    if (minutes < 60) return `${minutes} menit lagi`
    const time = new Date(resetAt)
    return `${String(time.getHours()).padStart(2, '0')}.${String(time.getMinutes()).padStart(2, '0')}`
  }

  function amount(entry: QuotaEntry): string {
    if (entry.remaining === undefined) return entry.state === 'cooldown' ? 'sedang cooldown' : 'tidak dilaporkan'
    const unit = entry.unit === 'usd' ? '$' : ''
    const value = entry.unit === 'usd' ? entry.remaining.toFixed(2) : String(Math.round(entry.remaining))
    return entry.limit ? `${unit}${value} dari ${entry.unit === 'usd' ? `$${entry.limit.toFixed(2)}` : Math.round(entry.limit)}` : `${unit}${value}`
  }

  const SOURCE_LABEL: Record<string, string> = {
    headers: 'header respons',
    credits: 'saldo kunci',
    dashboard: 'dashboard',
    observed: 'dari pemakaian',
  }

  /** Sisa limit tiap penyedia, beserta apa yang memang tidak dapat diketahui. */
  async function showLimits(): Promise<void> {
    console.log(`\n  ${theme.bold('Sisa limit')} ${theme.muted('· memeriksa penyedia…')}`)
    let report
    try {
      report = await gatherQuota({ profiles: profilesFromConfig(config), config })
    } catch (error) {
      console.log(`  ${theme.danger('error')} ${error instanceof Error ? error.message : 'gagal membaca limit'}\n`)
      return
    }

    if (!report.entries.length) console.log(`  ${theme.muted('Belum ada angka limit yang dapat dibaca.')}`)
    for (const entry of report.entries) {
      const mark = entry.state === 'ok' ? theme.accent('●') : entry.state === 'unknown' ? theme.muted('○') : theme.danger('●')
      const reset = entry.resetAt ? `  ${theme.muted(`pulih ${whenResets(entry.resetAt)}`)}` : ''
      console.log(`  ${mark} ${theme.bold(`${providerLabel(entry.providerId)} · ${entry.label}`)}`)
      console.log(`    ${amount(entry)}${reset}  ${theme.muted(`(${SOURCE_LABEL[entry.source] ?? entry.source})`)}`)
      if (entry.detail) console.log(`    ${theme.muted(entry.detail.slice(0, 120))}`)
    }

    if (report.usage.length) {
      console.log(`\n  ${theme.bold('Pemakaian di mesin ini')} ${theme.muted('· perkiraan token, sejak Boo dijalankan')}`)
      for (const usage of report.usage) {
        const failed = usage.failures ? theme.muted(` · ${usage.failures} gagal`) : ''
        const tokens = usage.inputTokens + usage.outputTokens
        const size = tokens < 1_000 ? `${tokens} token` : `${(tokens / 1_000).toFixed(1)}K token`
        console.log(`  ${theme.muted('·')} ${usage.model}  ${theme.muted(`${usage.requests} permintaan · ~${size}`)}${failed}`)
      }
    }
    for (const note of report.notes) console.log(`\n  ${theme.muted(note)}`)
    console.log()
  }

  async function undoChanges(): Promise<void> {
    const plan = await agent.checkpoints.plan()
    if (!plan) {
      console.log(`  ${theme.muted('Belum ada perubahan berkas oleh Boo di sesi ini yang bisa dibatalkan.')}\n`)
      return
    }
    if (!plan.entries.length) {
      await agent.undo()
      console.log(`  ${theme.muted('Berkasnya sudah sama dengan sebelum permintaan itu; tidak ada yang perlu dikembalikan.')}\n`)
      return
    }

    const width = Math.max(40, Math.min((stdout.columns || 80) - 2, 100))
    const prompt = plan.prompt.replace(/\s+/g, ' ')
    const request = {
      kind: 'other' as const,
      title: 'Batalkan perubahan',
      subject: prompt.length > 70 ? `${prompt.slice(0, 70)}…` : prompt,
      question: `Kembalikan ${plan.entries.length} berkas?`,
      allowAlways: '',
    }
    const panel = renderPanel(request, undoBody(plan), width)
    stdout.write(`\n${panel.join('\n')}\n`)
    const choice = await select(readline, {
      title: request.question,
      items: ['Ya, kembalikan', 'Tidak'],
      initialIndex: 0,
      numbered: true,
      hint: 'panah memilih · enter memakai · esc batal',
    })
    const confirmed = choice === undefined
      ? (await ask(`  ${request.question} [y/N] `))?.trim().toLowerCase() === 'y'
      : choice === 0
    if (!confirmed) {
      console.log(`  ${theme.muted('Tidak ada yang dikembalikan.')}\n`)
      return
    }
    const done = await agent.undo()
    const restored = done?.entries.filter((entry) => entry.action === 'restore').length ?? 0
    const deleted = done?.entries.filter((entry) => entry.action === 'delete').length ?? 0
    const parts = [restored ? `${restored} berkas dikembalikan` : '', deleted ? `${deleted} berkas baru dihapus` : ''].filter(Boolean)
    console.log(`  ${theme.accent('↺')} ${theme.muted(`${parts.join(', ')}. Boo diberi tahu di permintaan berikutnya.`)}\n`)
  }

  /** Memulihkan checkpoint lama beserta seluruh perubahan file sesudahnya. */
  async function restoreWorkspace(argument: string): Promise<void> {
    const points = agent.checkpoints.restorePoints()
    if (!points.length) {
      console.log(`  ${theme.muted('Belum ada checkpoint perubahan file di sesi ini.')}`)
      return
    }
    let selected: (typeof points)[number]
    if (argument) {
      if (!/^\d+$/.test(argument)) {
        console.log(`  ${theme.danger('Pakai /restore atau /restore <id-checkpoint>.')}\n`)
        return
      }
      const found = points.find((point) => point.checkpointId === Number(argument))
      if (!found) {
        console.log(`  ${theme.danger(`Checkpoint #${argument} tidak ditemukan di sesi ini.`)}\n`)
        return
      }
      selected = found
    } else {
      const recent = points.slice(0, 20)
      const picked = await select(readline, {
        title: 'Pulihkan workspace ke sebelum checkpoint',
        items: recent.map((point) => {
          const prompt = point.prompt.replace(/\s+/g, ' ').slice(0, 70)
          return `#${point.checkpointId}  ${relativeTime(point.createdAt).padEnd(14)}  ${prompt}${point.ranCommands ? ' · ada command' : ''}`
        }),
        initialIndex: 0,
        hint: 'checkpoint terpilih dan semua sesudahnya akan dikembalikan · esc batal',
      })
      if (picked === undefined) {
        console.log(`\n  ${theme.bold('Checkpoint file di sesi ini')}`)
        for (const point of recent) console.log(`  #${point.checkpointId}  ${point.prompt.replace(/\s+/g, ' ').slice(0, 80)}`)
        if (recent.length < points.length) console.log(`  ${theme.muted(`${points.length - recent.length} checkpoint lebih lama: pilih dengan /restore <id-checkpoint>`)}`)
        console.log(`  ${theme.muted('terminal ini tidak mendukung pemilih; pakai /restore <id-checkpoint>')}\n`)
        return
      }
      if (picked === null) {
        console.log(`  ${theme.muted('dibatalkan')}\n`)
        return
      }
      selected = recent[picked]!
    }

    let plan
    try {
      plan = await agent.checkpoints.planRestore(selected.checkpointId)
    } catch (error) {
      console.log(`  ${theme.danger(error instanceof Error ? error.message : 'Checkpoint tidak dapat ditinjau.')}\n`)
      return
    }
    if (!plan) {
      console.log(`  ${theme.danger('Checkpoint tidak lagi tersedia.')}\n`)
      return
    }
    const width = Math.max(40, Math.min((stdout.columns || 80) - 2, 100))
    const prompt = plan.prompt.replace(/\s+/g, ' ')
    const request = {
      kind: 'other' as const,
      title: 'Pulihkan workspace',
      subject: `checkpoint #${plan.checkpointId} · ${prompt.length > 60 ? `${prompt.slice(0, 60)}…` : prompt}`,
      question: `Kembalikan ${plan.entries.length} file melewati ${plan.checkpointCount} checkpoint?`,
      allowAlways: '',
    }
    const panel = renderPanel(request, undoBody(plan), width)
    stdout.write(`\n${panel.join('\n')}\n`)
    const choice = await select(readline, {
      title: request.question,
      items: ['Ya, pulihkan workspace', 'Tidak'],
      initialIndex: 1,
      numbered: true,
      hint: 'perubahan percakapan dan command tidak dikembalikan · esc batal',
    })
    const confirmed = choice === undefined
      ? (await ask(`  ${request.question} [y/N] `))?.trim().toLowerCase() === 'y'
      : choice === 0
    if (!confirmed) {
      console.log(`  ${theme.muted('Workspace tidak diubah.')}\n`)
      return
    }
    try {
      const done = await agent.restore(plan.checkpointId, plan.fingerprint)
      const restored = done?.entries.filter((entry) => entry.action === 'restore').length ?? 0
      const deleted = done?.entries.filter((entry) => entry.action === 'delete').length ?? 0
      const parts = [restored ? `${restored} file dikembalikan` : '', deleted ? `${deleted} file baru dihapus` : ''].filter(Boolean)
      console.log(`  ${theme.accent('↺')} ${theme.muted(`${parts.join(', ') || 'Workspace sudah berada pada keadaan target'}. ${plan.checkpointCount} checkpoint dilepas; percakapan tetap utuh.`)}\n`)
    } catch (error) {
      console.log(`  ${theme.danger(error instanceof Error ? error.message : 'Restore gagal.')}\n`)
    }
  }

  /**
   * Permintaan yang disusun Boo sendiri, dijalankan sebelum antrean. `display`
   * yang tampil di prompt, karena isi permintaannya panjang. `after` dijalankan
   * hanya bila permintaan itu selesai dengan normal.
   */
  interface InternalRequest {
    display: string
    prompt: string
    after?: () => Promise<void>
  }
  let internal: InternalRequest | null = null

  function specRequest(name: string, prompt: string, after: () => Promise<void> = () => offerSpecStep(name)): void {
    internal = { display: `/spec · ${specPromptTitle(prompt) ?? name}`, prompt, after }
  }

  function describeSpec(spec: SpecSummary): string {
    const done = spec.tasks.filter((task) => task.done).length
    switch (spec.stage) {
      case 'requirements': return 'belum ada requirements'
      case 'design': return 'requirements siap · berikutnya design'
      case 'tasks': return 'design siap · berikutnya tasks'
      case 'implementing': return `tugas ${done}/${spec.tasks.length} selesai`
      case 'done': return `selesai · ${spec.tasks.length} tugas`
    }
  }

  async function specCommand(argument: string): Promise<void> {
    if (argument) {
      const name = uniqueSpecName(workspace, argument)
      specRequest(name, requirementsPrompt(name, argument))
      return
    }
    const specs = listSpecs(workspace)
    if (!specs.length) {
      console.log(`  ${theme.muted(`Belum ada spec di ${SPECS_DIRECTORY}. Mulai dengan: /spec <ide fitur>, misal /spec login dengan Google`)}\n`)
      return
    }
    const picked = await choose('Spec di proyek ini', specs.map((spec) => `${spec.name}  ${theme.muted(describeSpec(spec))}`), -1, 0)
    if (picked === null) return
    await offerSpecStep(specs[picked].name)
  }

  /** Menawarkan langkah berikutnya sesuai tahap spec, setelah setiap tahap selesai. */
  async function offerSpecStep(name: string): Promise<void> {
    const spec = readSpec(workspace, name)
    const where = `${SPECS_DIRECTORY}/${name}`
    if (!spec || spec.stage === 'requirements') {
      console.log(`  ${theme.muted(`${where}/requirements.md belum ditulis. Mulai ulang dengan /spec <ide fitur>.`)}\n`)
      return
    }
    if (spec.stage === 'done') {
      console.log(`  ${theme.accent('✓')} ${theme.muted(`Semua ${spec.tasks.length} tugas spec ${name} selesai.`)}\n`)
      return
    }

    const revise = async (document: SpecDocument) => {
      const feedback = (await ask(`  ${theme.accent('✎')} ${theme.bold(`Arahan revisi ${document}:`)} `))?.trim()
      if (feedback) specRequest(name, revisePrompt(name, document, feedback))
    }

    if (spec.stage === 'design' || spec.stage === 'tasks') {
      const [ready, next, prompt] = spec.stage === 'design'
        ? ['requirements.md', 'design', designPrompt(name)] as const
        : ['design.md', 'tasks', tasksPrompt(name)] as const
      const choice = await choose(
        `${where}/${ready} siap ditinjau. Langkah berikutnya?`,
        [`Setujui dan lanjut ke ${next}`, `Revisi ${ready}`, 'Berhenti dulu (lanjutkan nanti dengan /spec)'],
        -1,
        0,
      )
      if (choice === 0) specRequest(name, prompt)
      else if (choice === 1) await revise(ready)
      return
    }

    const task = nextTask(spec) as SpecTask
    const done = spec.tasks.filter((item) => item.done).length
    const choice = await choose(
      `${where}/tasks.md · ${done}/${spec.tasks.length} selesai · berikutnya ${task.number}. ${task.title}`,
      ['Kerjakan tugas berikutnya', 'Kerjakan semua tugas yang tersisa', 'Revisi tasks.md', 'Berhenti dulu (lanjutkan nanti dengan /spec)'],
      -1,
      0,
    )
    if (choice === 0 || choice === 1) specRequest(name, taskPrompt(name, task), () => afterSpecTask(name, task, choice === 1))
    else if (choice === 2) await revise('tasks.md')
  }

  /** Setelah satu tugas: lanjut otomatis bila diminta dan tugasnya benar-benar dicentang. */
  async function afterSpecTask(name: string, task: SpecTask, all: boolean): Promise<void> {
    const spec = readSpec(workspace, name)
    const updated = spec?.tasks.find((item) => item.number === task.number)
    if (!spec || !updated?.done) {
      console.log(`  ${theme.muted(`Tugas ${task.number} belum dicentang di tasks.md, jadi dianggap belum selesai.`)}\n`)
      if (spec) await offerSpecStep(name)
      return
    }
    const next = nextTask(spec)
    if (all && next) {
      console.log(`  ${theme.accent('✓')} ${theme.muted(`Tugas ${task.number} selesai · lanjut ke tugas ${next.number} (esc untuk berhenti)`)}\n`)
      specRequest(name, taskPrompt(name, next), () => afterSpecTask(name, next, true))
      return
    }
    await offerSpecStep(name)
  }

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
      console.log(`  ${theme.muted(`terminal ini tidak mendukung pemilih; jalankan ${COMMAND} --resume <id>`)}\n`)
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
    modelMode = session.modelMode ?? 'manual'
    recorder = new SessionRecorder({
      workspace,
      model: session.model ?? provider.model,
      reasoningEffort: session.reasoningEffort,
      modelMode,
      resumeId: session.id,
    })
    agent = createAgent(session.messages, session.compaction)
    pendingImages.length = 0
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

  /**
   * Menyalin state percakapan ke id baru. Berkas workspace sengaja tidak disalin:
   * kedua sesi tetap bekerja pada direktori yang sama, sedangkan checkpoint undo
   * dimulai baru agar cabang tidak membatalkan perubahan milik sesi asal.
   */
  function forkCurrentSession(): void {
    if (!recorder.started) {
      console.log(`  ${theme.muted('Belum ada percakapan untuk dicabangkan. Kirim satu pesan terlebih dahulu.')}\n`)
      return
    }
    const sourceId = recorder.id
    let session: LoadedSession
    try {
      session = forkSession(sourceId)
    } catch (error) {
      console.log(`  ${theme.danger('error')} ${error instanceof Error ? error.message : 'sesi gagal dicabangkan'}\n`)
      return
    }

    modelMode = session.modelMode ?? 'manual'
    if (session.model) {
      provider.model = session.model
      provider.reasoningEffort = validEffort(session.model, session.reasoningEffort)
    }
    recorder = new SessionRecorder({
      workspace,
      model: session.model ?? provider.model,
      reasoningEffort: session.reasoningEffort,
      modelMode,
      resumeId: session.id,
    })
    agent = createAgent(session.messages, session.compaction)
    pendingImages.length = 0
    sessionApprovals.clear()
    const typedHistory = (readline as unknown as { history?: string[] }).history
    if (typedHistory) typedHistory.splice(0, typedHistory.length, ...promptsOf(session.messages))

    console.log(`  ${theme.accent('✓')} ${theme.bold(`cabang ${shortId(session.id)} dibuat dari ${shortId(sourceId)}`)}`)
    console.log(`  ${theme.muted('Konteks percakapan disalin; file workspace tetap dipakai bersama dan riwayat /undo dimulai baru.')}\n`)
  }

  /**
   * Membuat cabang tepat sebelum prompt yang dipilih. Sesi asal dan workspace
   * tidak disentuh; ini rewind konteks percakapan, bukan rewind perubahan file.
   */
  async function rewindCurrentSession(argument: string): Promise<void> {
    if (!recorder.started) {
      console.log(`  ${theme.muted('Belum ada percakapan untuk diputar balik. Kirim satu pesan terlebih dahulu.')}\n`)
      return
    }

    const sourceId = recorder.id
    let source: LoadedSession
    try {
      source = loadSession(sourceId)
    } catch (error) {
      console.log(`  ${theme.danger('error')} ${error instanceof Error ? error.message : 'sesi gagal dimuat'}\n`)
      return
    }
    const turns = sessionTurns(source.messages)
    if (!turns.length) {
      console.log(`  ${theme.muted('Sesi ini belum memiliki prompt yang dapat dipilih.')}\n`)
      return
    }

    let selected: (typeof turns)[number]
    if (argument) {
      if (!/^\d+$/.test(argument)) {
        console.log(`  ${theme.danger(`Nomor prompt tidak sah: ${argument}`)}`)
        console.log(`  ${theme.muted('Pakai /rewind atau /rewind <nomor>.')}\n`)
        return
      }
      const number = Number(argument)
      const match = turns.find((turn) => turn.number === number)
      if (!match) {
        console.log(`  ${theme.danger(`Prompt #${number} tidak ditemukan.`)}`)
        console.log(`  ${theme.muted(`Sesi ini memiliki prompt #1 sampai #${turns.at(-1)?.number}.`)}\n`)
        return
      }
      selected = match
    } else {
      const choices = [...turns].reverse()
      const picked = await select(readline, {
        title: 'Putar balik ke sebelum prompt',
        items: choices.map((turn) => `#${turn.number}  ${turn.title}`),
        initialIndex: 0,
        hint: 'sesi asal tetap utuh · esc membatalkan',
      })
      if (picked === undefined) {
        console.log(`\n  ${theme.bold('Prompt dalam sesi ini')}`)
        choices.forEach((turn) => console.log(`  #${turn.number}  ${turn.title}`))
        console.log(`  ${theme.muted('terminal ini tidak mendukung pemilih; pakai /rewind <nomor>')}\n`)
        return
      }
      if (picked === null) {
        console.log(`  ${theme.muted('dibatalkan')}\n`)
        return
      }
      selected = choices[picked]!
    }

    let session: LoadedSession
    try {
      session = forkSessionAt(sourceId, selected.messageIndex)
    } catch (error) {
      console.log(`  ${theme.danger('error')} ${error instanceof Error ? error.message : 'sesi gagal diputar balik'}\n`)
      return
    }

    modelMode = session.modelMode ?? 'manual'
    if (session.model) {
      provider.model = session.model
      provider.reasoningEffort = validEffort(session.model, session.reasoningEffort)
    }
    recorder = new SessionRecorder({
      workspace,
      model: session.model ?? provider.model,
      reasoningEffort: session.reasoningEffort,
      modelMode,
      resumeId: session.id,
    })
    agent = createAgent(session.messages, session.compaction)
    pendingImages.length = 0
    sessionApprovals.clear()
    const typedHistory = (readline as unknown as { history?: string[] }).history
    if (typedHistory) typedHistory.splice(0, typedHistory.length, ...promptsOf(session.messages))

    console.log(`  ${theme.accent('✓')} ${theme.bold(`cabang ${shortId(session.id)} dibuat sebelum prompt #${selected.number}`)}`)
    console.log(`  ${theme.muted(`Sesi asal ${shortId(sourceId)} tetap utuh. File workspace tidak diubah; riwayat /undo dimulai baru.`)}\n`)
  }

  if (resumed) showResumed(resumed, agent.restored)
  const sandboxStatus = inspectSandbox(workspace, sandbox)
  const sandboxLabel = sandboxStatus.enforced
    ? `${sandboxStatus.mode} · ${sandboxStatus.backend} · network ${sandboxStatus.networkAccess ? 'on' : 'off'}`
    : `${sandboxStatus.mode} · tidak enforced (${sandboxStatus.reason})`
  console.log(`  ${theme.muted(`sandbox: ${sandboxLabel}`)}`)
  console.log(`  ${theme.muted('ketik perintah, /help untuk daftar perintah')}\n`)
  if (process.platform === 'darwin' && process.env.TERM_PROGRAM === 'Apple_Terminal') {
    console.log(`  ${theme.muted('Terminal.app tidak mengirim Shift+Enter secara bawaan. Lihat README untuk mapping satu kali, atau gunakan Esc lalu Enter.')}\n`)
  }

  /** Bagaimana permintaan terakhir berakhir; diisi setiap kali permintaan dimulai. */
  let outcome: 'done' | 'cancelled' | 'stopped'
  for (;;) {
    // Nama model di baris sendiri dan tempat mengetik di bawahnya. Header dicetak
    // terpisah, bukan dijadikan bagian prompt: prompt readline yang memuat baris
    // baru rusak saat readline menggambar ulang barisnya, misalnya ketika riwayat
    // dipanggil atau ketikan dipulihkan setelah spinner berhenti.
    // Dibangun ulang setiap putaran agar selalu mencerminkan model yang sedang
    // dipakai, termasuk sesaat setelah /model mengubahnya.
    const header = `${theme.accentBold('boo')} ${theme.muted(`· ${currentModelLabel()}`)}`
    const promptText = `${theme.accentBold('›')} `
    let input: string
    let after: (() => Promise<void>) | undefined
    let requestMode: 'normal' | 'review' | 'plan' = 'normal'

    // Permintaan yang disusun Boo sendiri lebih dulu, lalu antrean, berurutan.
    const job = internal as InternalRequest | null
    const queued = job ? undefined : pending.shift()
    if (job) {
      internal = null
      stdout.write(`${header}\n${promptText}${job.display}\n`)
      input = job.prompt
      after = job.after
    } else if (queued !== undefined) {
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
    if (input === '/stats') {
      showLocalStats()
      continue
    }
    if (input === '/context') {
      showContextUsage()
      continue
    }
    if (input === '/status') {
      await showTaskStatus()
      continue
    }
    if (input === '/capabilities') {
      console.log(`\n  ${formatProviderCapabilityProfile(loadProviderCapabilityProfile(homedir())).replaceAll('\n', '\n  ')}\n`)
      continue
    }
    if (input === '/postmortem') {
      console.log(`\n  ${formatFailurePostmortem(loadLatestFailurePostmortem(homedir(), workspace)).replaceAll('\n', '\n  ')}\n`)
      continue
    }
    if (input === '/doctor') {
      await showDoctor(workspace, config, sandboxStatus)
      continue
    }
    if (input === '/model' || input.startsWith('/model ')) {
      await changeModel(input.slice('/model'.length).trim())
      continue
    }
    if (input === '/apps') {
      showApps()
      continue
    }
    if (input === '/commands') {
      showCommands()
      continue
    }
    if (input === '/hooks') {
      showHooks()
      continue
    }
    if (input === '/permissions') {
      showPermissions()
      continue
    }
    if (input === '/attach' || input.startsWith('/attach ')) {
      attachImage(input.slice('/attach'.length))
      continue
    }
    if (input === '/attachments' || input.startsWith('/attachments ')) {
      showAttachments(input.slice('/attachments'.length).trim())
      continue
    }
    if (input === '/open' || input.startsWith('/open ')) {
      await openRegisteredApp(input.slice('/open'.length).trim())
      continue
    }
    if (input === '/run' || input.startsWith('/run ')) {
      await runDirectCommand(input.slice('/run'.length).trim())
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
    if (input === '/fork') {
      forkCurrentSession()
      continue
    }
    if (input === '/rewind' || input.startsWith('/rewind ')) {
      await rewindCurrentSession(input.slice('/rewind'.length).trim())
      continue
    }
    if (input === '/undo') {
      await undoChanges()
      continue
    }
    if (input === '/limit' || input === '/usage') {
      await showLimits()
      continue
    }
    if (input === '/restore' || input.startsWith('/restore ')) {
      await restoreWorkspace(input.slice('/restore'.length).trim())
      continue
    }
    if (input === '/spec' || input.startsWith('/spec ')) {
      await specCommand(input.slice('/spec'.length).trim())
      continue
    }
    if (input === '/plan' || input.startsWith('/plan ')) {
      try {
        input = planRequest(input.slice('/plan'.length))
        requestMode = 'plan'
      } catch (error) {
        console.log(`  ${theme.danger(error instanceof Error ? error.message : 'Tulis tugas setelah /plan.')}`)
        continue
      }
    }
    if (input === '/implement') {
      const saved = latestPlan(agent.history)
      if (!saved) {
        console.log(`  ${theme.danger('Belum ada rencana /plan yang selesai di sesi ini.')}`)
        continue
      }
      input = implementPlanRequest(saved)
    }
    if (input === '/review' || input.startsWith('/review ')) {
      try {
        input = reviewRequest(input.slice('/review'.length).trim() || undefined)
        requestMode = 'review'
      } catch (error) {
        console.log(`  ${theme.danger(error instanceof Error ? error.message : 'Base review tidak valid.')}`)
        continue
      }
    }
    if (input === '/init') input = INIT_PROMPT
    if (input.startsWith('/')) {
      try {
        const expanded = expandPromptCommand(input, loadPromptCommands({ workspace, home: homedir() }))
        if (expanded) input = expanded.prompt
      } catch (error) {
        console.log(`  ${theme.danger(error instanceof Error ? error.message : 'Custom command gagal dimuat.')}`)
        continue
      }
    }

    const requestImages = !job && input !== '/compact' ? pendingImages.splice(0) : []
    if (requestImages.length) console.log(`  ${theme.muted(`gambar: ${requestImages.map((image) => image.name).join(', ')}`)}`)
    busy = true
    outcome = 'done'
    currentRequest = new AbortController()
    try {
      const tally = new PhaseTally()
      tally.reset()
      // Keterangan tool dicatat saat mulai; event tool-end hanya membawa nama.
      const previews = new Map<string, string>()
      // Tugas in_progress dari daftar tugas terakhir, untuk keterangan baris status.
      let currentTask = ''
      // Ekor keluaran perintah yang sedang berjalan, per pemanggilan tool.
      const outputs = new Map<string, string>()
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

      // /compact yang tidak menghasilkan kabar apa pun berarti tidak ada yang diringkas.
      let compactionReported = false
      const rawEvents = input === '/compact'
        ? agent.compact({ signal: currentRequest.signal })
        : agent.send(input, { signal: currentRequest.signal, ...(requestMode === 'normal' ? {} : { mode: requestMode }), ...(requestImages.length ? { images: requestImages } : {}) })
      const trace = new LocalRunTrace({
        home: homedir(), workspace, surface: 'cli', kind: input === '/compact' ? 'compact' : 'send',
        mode: modelMode, model: provider.model, reasoningEffort: provider.reasoningEffort,
        requestCharacters: input === '/compact' ? 0 : input.length,
        enabled: tracingEnabled(config.BOO_TRACE),
      })
      const journal = new PersistentRunJournal({
        home: homedir(), workspace, sessionId: recorder.id, surface: 'cli',
        kind: input === '/compact' ? 'compact' : 'send', model: provider.model,
        ...(provider.reasoningEffort ? { reasoningEffort: provider.reasoningEffort } : {}),
      })
      const events = journalAgentEvents(traceAgentEvents(rawEvents, trace), journal)
      for await (const event of events) {
        switch (event.type) {
          case 'model-routing':
            status.activity('Selecting model', 'menilai kesulitan tugas')
            break
          case 'model-selected':
            recorder.recordModel(event.model, event.reasoningEffort)
            status.clear()
            emit(`  ${theme.accent('Auto')} · ${theme.bold(modelLabel(event.model, event.reasoningEffort))} · ${DIFFICULTY_LABEL[event.difficulty]}${event.source === 'local' ? ' (perkiraan lokal)' : ''}\n  ${theme.muted(event.reason)}\n`)
            break
          case 'turn-start':
            toolCalls.clear()
            lastToolActivity = ''
            // Tugas yang sedang dikerjakan menemani label berpikir, agar terlihat arahnya.
            status.activity(turnActivity(event.turn), currentTask)
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
            // Daftar tugas bukan bagian fase mana pun; ia tampil utuh setelah selesai.
            if (event.name === 'todo_write' || event.name === 'ask_user') {
              status.activity(event.name === 'ask_user' ? 'Waiting' : 'Planning', event.name === 'ask_user' ? 'menunggu jawaban pengguna' : '')
              break
            }
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
            if (event.name === 'todo_write') {
              const todos = parseTodos(event.args.todos)
              if (typeof todos !== 'string') {
                status.commit()
                emit(renderTodos(todos))
                currentTask = todoProgress(todos).current ?? ''
              }
              break
            }
            if (event.name === 'ask_user') {
              status.activity('Waiting', 'menunggu jawaban pengguna')
              break
            }
            if (status.currentPhase !== phaseOf(event.name)) tally.reset()
            status.work(phaseOf(event.name), toolActivity(event.name), describeArgs(event.name, event.args))
            break
          }

          case 'tool-output': {
            // Baris terakhir keluaran perintah tampil di baris status selagi berjalan.
            const output = ((outputs.get(event.callId) ?? '') + event.chunk).slice(-4_000)
            outputs.set(event.callId, output)
            const line = lastOutputLine(output)
            if (line) status.activity(toolActivity(event.name), line)
            break
          }

          case 'tool-end': {
            outputs.delete(event.callId)
            if ((event.name === 'todo_write' || event.name === 'ask_user') && !event.isError) break
            // Event cancelled menyusul dan menutup tampilannya sendiri.
            if (event.cancelled) {
              status.discardEmpty()
              break
            }
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

          case 'tool-cache-hit':
            status.activity(toolActivity(event.name), `cache ${event.ref} · hemat ${event.savedCharacters.toLocaleString('id-ID')} karakter`)
            break

          case 'tool-result-truncated':
            status.activity(toolActivity(event.name), `${event.originalCharacters.toLocaleString('id-ID')} karakter · ${event.ref ? `tersimpan ${event.ref}` : 'bagian tengah tidak disimpan'}`)
            break

          case 'tool-parallel':
            if (event.stage === 'started') status.activity('Exploring', `${event.calls} tool paralel · ${event.tools.join(', ')}`)
            break

          case 'tool-recovery':
            status.activity('Recovering', `${event.category} timeout · batas berikutnya ${Math.ceil(event.nextIdleTimeoutMs / 1_000)}s`)
            break

          case 'tool-denied':
            // Keputusannya sudah dicatat oleh panel izin. Fase yang dibuka hanya untuk
            // tool yang ditolak ini dibuang agar tidak membeku sebagai ringkasan kosong.
            status.discardEmpty()
            status.clear()
            break

          case 'tool-invalid':
            finishAnswer()
            status.discardEmpty()
            status.clear()
            emit(`  ${theme.danger('!')} ${theme.bold(event.name)} ${theme.muted('tidak dijalankan · argumen tidak valid')}\n${event.issues.map((issue) => `    ${theme.muted(issue)}`).join('\n')}\n`)
            break

          case 'tool-loop': {
            if (event.stage === 'stopped') outcome = 'stopped'
            finishAnswer()
            status.commit()
            const message = event.stage === 'warning'
              ? event.repetitions === 1
                ? `${event.name} ditolak pengguna; pengulangan identik berikutnya akan diblokir.`
                : `${event.name} memberi hasil identik berulang; Boo diminta mengganti pendekatan.`
              : event.stage === 'blocked'
                ? `${event.name} diblokir sebelum dijalankan karena panggilan identik stagnan.`
                : `Task dihentikan: ${event.name} tetap diulang setelah diperingatkan dan diblokir.`
            emit(`  ${event.stage === 'warning' ? theme.accent('!') : theme.danger('!')} ${theme.muted(message)}\n`)
            break
          }

          case 'tool-protocol': {
            if (event.stage === 'stopped') outcome = 'stopped'
            finishAnswer()
            status.commit()
            const message = event.stage === 'warning'
              ? `Model menghasilkan function call invalid selama ${event.consecutiveTurns} putaran; Boo meminta koreksi terakhir.`
              : event.stage === 'fallback'
                ? `Function-calling ${event.model} tidak stabil; mode Auto memilih model cadangan.`
                : `Task dihentikan karena function call tetap invalid selama ${event.consecutiveTurns} putaran.`
            emit(`  ${event.stage === 'warning' ? theme.accent('!') : theme.danger('!')} ${theme.muted(message)}\n`)
            break
          }

          case 'hook-start':
            status.activity('Running', `hook ${event.event}:${event.id}`)
            break

          case 'hook-end':
            status.clear()
            if (!event.denied) recordDecision(event.success, `Hook ${event.event}:${event.id} · ${event.success ? 'selesai' : event.content.split('\n')[0]}`)
            break

          case 'turn-end':
            // Giliran berikutnya dimulai dengan model berpikir lagi. Kalimat
            // pengantar sebelum pemanggilan tool harus diakhiri dulu: spinner
            // menggambar dengan membersihkan barisnya dan akan menghapus kalimat itu.
            // Tool dijalankan berikutnya dan menampilkan labelnya sendiri.
            if (event.message.tool_calls?.length) finishAnswer()
            break

          case 'cancelled':
            outcome = 'cancelled'
            finishAnswer()
            // Pekerjaan yang sempat selesai tetap diringkas; fase kosong dibuang.
            status.discardEmpty()
            status.commit()
            emit(`  ${theme.danger('✗')} ${theme.muted('Dibatalkan')}\n`)
            break

          case 'instructions-reloaded':
            emit(`  ${theme.muted(event.files.length
              ? `aturan proyek dimuat ulang: ${describeInstructions(event.files)}`
              : 'aturan proyek tidak lagi ada; Boo bekerja tanpa aturan proyek')}\n`)
            break

          case 'retry': {
            // Jawaban yang sempat mengalir ditutup; jawaban ulangan tampil di bawahnya.
            finishAnswer()
            status.clear()
            if (midLine) emit('\n')
            const reason = event.message.split('\n')[0].slice(0, 160)
            const seconds = Math.ceil(event.delayMs / 1_000)
            emit(`  ${theme.muted(`↻ ${reason} · mencoba lagi dalam ${seconds}s (${event.attempt}/${event.maxAttempts})`)}\n`)
            status.activity('Retrying', `percobaan ${event.attempt} dari ${event.maxAttempts}`)
            break
          }

          case 'turn-limit':
            outcome = 'stopped'
            finishAnswer()
            status.commit()
            emit(`  ${theme.muted('Ketik "lanjutkan" untuk meneruskan pekerjaannya.')}\n`)
            break

          case 'verification-needed':
            finishAnswer()
            status.activity('Verifying', event.tests?.length
              ? `${event.tests.slice(0, 3).join(', ')}${event.tests.length > 3 ? ` +${event.tests.length - 3}` : ''}`
              : event.commands?.[0] ?? event.files.join(', '))
            break

          case 'change-impact':
            finishAnswer()
            status.activity('Checking', `${event.affectedFiles} file terdampak · ${event.edges} relasi · blast radius ${event.blastRadius}${event.truncated ? ' · dibatasi' : ''}`)
            break

          case 'lsp-session':
            finishAnswer()
            status.activity(event.stage === 'reused' ? 'Checking' : 'Starting', `LSP ${event.stage} · ${event.openDocuments} dokumen aktif`)
            break

          case 'verification-incomplete':
            finishAnswer()
            status.commit()
            emit(`  ${theme.danger('!')} ${theme.muted(`${event.attempted ? 'Verifikasi belum berhasil' : 'Belum ada verifikasi'} untuk ${event.files.join(', ')}`)}\n`)
            break

          case 'verification-repair':
            finishAnswer()
            if (event.stage === 'repaired') {
              status.commit()
              emit(`  ${theme.accent('✓')} ${theme.muted(`Verification repair berhasil · ${event.round} putaran`)}\n`)
            } else if (event.stage === 'exhausted') {
              status.commit()
              emit(`  ${theme.danger('!')} ${theme.muted(`Verification repair berhenti aman setelah ${event.round}/${event.maxRounds} putaran`)}\n`)
            } else {
              status.activity('Repairing', `verifikasi · putaran ${event.round}/${event.maxRounds}`)
            }
            break

          case 'critic-start':
            finishAnswer()
            status.activity('Reviewing', `review otomatis ${event.round}/${MAX_AUTO_REVIEW_ROUNDS}`)
            break

          case 'critic-end':
            status.clear()
            if (event.status === 'pass') emit(`  ${theme.accent('✓')} ${theme.muted(`Review otomatis lulus · ${modelLabel(event.model, undefined)}`)}\n`)
            else if (event.status === 'findings') emit(`  ${theme.danger('!')} ${theme.muted(`Reviewer menemukan ${event.findings} masalah; Boo akan memeriksanya`)}\n`)
            else if (event.status === 'error') emit(`  ${theme.muted(`Review otomatis dilewati: ${event.message ?? 'reviewer gagal'}`)}\n`)
            else emit(`  ${theme.muted('Batas review otomatis tercapai; hasil terakhir dipertahankan.')}\n`)
            break

          case 'steering':
            finishAnswer()
            status.commit()
            emit(`  ${theme.accent('↳')} ${theme.muted(`${event.messages.length} arahan tengah jalan diterapkan`)}\n`)
            break

          case 'risk-assessed':
            if (event.assessment.level !== 'low') {
              finishAnswer()
              status.commit()
              emit(`  ${event.assessment.level === 'high' ? theme.danger('◆') : theme.accent('◇')} ${theme.muted(`risiko ${event.assessment.level} · ${event.assessment.reasons.join('; ')}`)}\n`)
            }
            break

          case 'prompt-injection-detected':
            finishAnswer()
            status.commit()
            emit(`  ${theme.danger('!')} ${theme.muted(`prompt injection dicurigai pada ${event.tool} (${event.categories.join(', ')}) · aksi berisiko wajib approval baru`)}\n`)
            break

          case 'risk-verification-weak':
            finishAnswer()
            status.commit()
            emit(`  ${theme.danger('!')} ${theme.muted('Perubahan berisiko tinggi hanya memiliki bukti verifikasi dasar; reviewer otomatis tetap dijalankan.')}\n`)
            break

          case 'compacting':
            finishAnswer()
            status.activity('Compacting', 'meringkas percakapan lama')
            break

          case 'compacted':
            compactionReported = true
            status.clear()
            if (midLine) emit('\n')
            emit(`  ${theme.accent('↻')} ${theme.muted(`konteks diringkas: ${event.summarizedMessages} pesan lama menjadi ringkasan (~${event.estimatedTokens} token terkirim)`)}\n`)
            break

          case 'compaction-failed':
            compactionReported = true
            status.clear()
            if (midLine) emit('\n')
            emit(`  ${theme.muted(`ringkasan konteks gagal (${event.message.split('\n')[0].slice(0, 120)}); pesan lama dipangkas`)}\n`)
            break

          case 'context-trimmed':
            status.clear()
            if (midLine) emit('\n')
            emit(`  ${theme.muted(`konteks dipangkas: ${event.droppedMessages} pesan dibuang, ${event.prioritizedMessages} pesan relevan lama dipertahankan${event.dependencyMessages ? `, ${event.dependencyMessages} pesan dependency melalui ${event.dependencyEdges ?? 0} relasi` : ''} (~${event.estimatedTokens} token terkirim)`)}\n`)
            break

          case 'workspace-changed': {
            finishAnswer()
            status.commit()
            const kinds = { modified: 'diubah', deleted: 'dihapus', unsafe: 'path tidak aman', unreadable: 'tak terbaca' } as const
            const files = event.files.map((file) => `${file.path} (${kinds[file.kind]})`)
            if (event.remaining) files.push(`… ${event.remaining} file lain`)
            emit(`  ${theme.danger('!')} ${theme.muted(`workspace berubah di luar Boo: ${files.join(', ')} · Boo diminta membaca ulang`)}\n`)
            break
          }

          case 'error':
            outcome = 'stopped'
            status.clear()
            finishAnswer()
            emit(`\n  ${theme.danger('error')} ${event.message}\n`)
            break

          case 'failure-postmortem':
            status.clear()
            finishAnswer()
            emit(`  ${theme.muted(formatFailurePostmortem(event.report).replaceAll('\n', '\n  '))}\n`)
            break

          default:
            break
        }
      }
      finishAnswer()
      status.commit()
      if (input === '/compact' && !compactionReported && outcome === 'done') {
        emit(`  ${theme.muted('Belum ada percakapan baru untuk diringkas.')}\n`)
      }
    } finally {
      // Ketikan yang belum dikirim tetap tersimpan di readline dan akan tampil lagi
      // bersama prompt berikutnya; keluaran yang ditahan dilepas lebih dulu.
      stopTyping(true)
      // Sibuk harus selalu dilepas; bila tersangkut, seluruh ketikan
      // berikutnya akan masuk antrean dan sesi tampak membeku.
      busy = false
      currentRequest = null
    }
    stdout.write(midLine ? '\n\n' : '\n')
    midLine = false
    // Langkah lanjutan hanya setelah permintaan selesai normal; Esc atau error menghentikan alurnya.
    if (after && outcome === 'done') await after()
  }

  readline.close()
  printResumeHint()
  console.log(`\n  ${theme.accent('Sampai jumpa.')}\n`)
}

await main()
