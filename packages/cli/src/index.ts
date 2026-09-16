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
import { readFileSync } from 'node:fs'
import {
  Agent,
  createDefaultRegistry,
  describeSelection,
  diffStats,
  findSelection,
  groupModels,
  NineRouterProvider,
  type DiffLine,
  type ModelFamily,
} from '@boo/core'
import { GLOBAL_CONFIG_PATH, loadConfig } from './config.ts'
import { select } from './select.ts'
import { PhaseTally, phaseOf, StatusLine } from './status.ts'
import { banner, theme } from './theme.ts'

const DEFAULT_MODEL = 'ag/claude-sonnet-4-6'

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

/** Jumlah baris diff yang ditampilkan sebelum sisanya diringkas. */
const MAX_DIFF_PREVIEW_LINES = 40

/** Menggambar diff berwarna: hijau untuk tambahan, merah untuk penghapusan. */
function renderDiff(detail: DiffLine[]): string {
  const { added, removed } = diffStats(detail)
  const shown = detail.slice(0, MAX_DIFF_PREVIEW_LINES)
  const body = shown.map((line) => {
    if (line.kind === 'add') return theme.added(`    + ${line.text}`)
    if (line.kind === 'remove') return theme.removed(`    - ${line.text}`)
    return theme.muted(`      ${line.text}`)
  })
  if (detail.length > shown.length) {
    body.push(theme.muted(`    … ${detail.length - shown.length} baris diff lagi`))
  }
  const summary = theme.muted(`    ${added} baris ditambah, ${removed} dihapus`)
  return `${body.join('\n')}\n${summary}`
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
  // Urutan prioritas: flag baris perintah, lalu konfigurasi, lalu bawaan.
  const model = flagValue('model', 'm') || config.BOO_MODEL || DEFAULT_MODEL
  const requestedEffort = flagValue('effort') || config.BOO_EFFORT
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

  const readline = createInterface({ input: stdin, output: stdout })
  const status = new StatusLine()

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
      const text = line.trim()
      if (!text) return
      if (isQueueCommand(text)) {
        status.pause()
        queueCommand(text.slice('/queue'.length).trim())
        status.note('')
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
    stdin.on('keypress', () => {
      if (!busy) return
      // Menggambar ulang sekali memulihkan huruf pertama, yang tergema ke baris
      // spinner sebelum baris itu sempat dibersihkan.
      if (status.pause()) readline.prompt(true)
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

  const agent = new Agent({
    provider,
    registry: createDefaultRegistry(),
    workspace,
    ...(config.BOO_MAX_CONTEXT_TOKENS
      ? { maxContextTokens: Number(config.BOO_MAX_CONTEXT_TOKENS) }
      : {}),
    async askPermission({ preview, name, detail }) {
      // Baris status hidup harus dibuang dulu; spinner akan menimpa prompt izin.
      status.clear()
      if (detail?.length) console.log(`\n${renderDiff(detail)}`)
      // Pertanyaan izin sengaja memuat perintah utuh: pengguna menyetujui
      // tindakan yang terlihat, bukan nama tool yang abstrak.
      const answer = await ask(
        `\n  ${theme.danger('izin')} ${theme.bold(name)}  ${preview}\n  ${theme.muted('jalankan? [y/N] ')}`,
      )
      // null berarti stdin tertutup; perlakukan sebagai tidak diizinkan.
      return answer?.trim().toLowerCase() === 'y'
    },
  })

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
    console.log()
    const picked = await select(readline, {
      title,
      items: labels,
      activeIndex,
      initialIndex: Math.max(0, initialIndex),
      activeLabel: '(aktif)',
      hint: 'panah atas/bawah memilih, enter memakai, esc membatalkan',
    })
    if (picked !== undefined) return picked

    console.log(`  ${theme.bold(title)}`)
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
  console.log(`  ${theme.muted('ketik perintah, /help untuk daftar perintah')}\n`)

  for (;;) {
    // Dibangun ulang setiap putaran agar selalu mencerminkan model yang sedang
    // dipakai, termasuk sesaat setelah /model mengubahnya.
    const promptText = `${theme.accentBold('boo')} ${theme.muted(`· ${modelLabel(provider.model, provider.reasoningEffort)}`)} ${theme.accent('›')} `
    let input: string

    // Permintaan yang sudah mengantre dikerjakan lebih dulu, berurutan.
    const queued = pending.shift()
    if (queued !== undefined) {
      const sisa = pending.length ? theme.muted(`  (${pending.length} lagi mengantre)`) : ''
      stdout.write(`${promptText}${queued}${sisa}\n`)
      input = queued
    } else {
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

    busy = true
    try {
      const tally = new PhaseTally()
      tally.reset()
      // Keterangan tool dicatat saat mulai; event tool-end hanya membawa nama.
      const previews = new Map<string, string>()
      let streamingText = false

      // Model sudah dipanggil tetapi belum membalas apa pun.
      status.thinking()

      for await (const event of agent.send(input)) {
        switch (event.type) {
          case 'text':
            if (!streamingText) {
              status.commit()
              stdout.write('\n  ')
              streamingText = true
            }
            stdout.write(event.delta.replace(/\n/g, '\n  '))
            break

          case 'tool-start': {
            if (streamingText) {
              stdout.write('\n')
              streamingText = false
            }
            previews.set(event.callId, event.preview)
            const phase = phaseOf(event.name)
            status.work(phase, event.preview)
            break
          }

          case 'tool-end': {
            tally.record(event.name, event.isError, targetOf(previews.get(event.callId) ?? ''))
            const phase = phaseOf(event.name)
            status.update(phase === 'exploring' ? tally.exploring() : tally.applying())
            // Kegagalan tidak boleh disembunyikan di balik ringkasan.
            if (event.isError) {
              status.commit()
              console.log(`  ${theme.danger('gagal')} ${theme.bold(event.name)}\n${summarize(event.content, 4)}`)
            } else if (VERBOSE) {
              status.commit()
              console.log(summarize(event.content))
            }
            break
          }

          case 'tool-denied':
            status.clear()
            console.log(`  ${theme.muted(`${event.name} dilewati`)}`)
            break

          case 'turn-end':
            // Giliran berikutnya dimulai dengan model berpikir lagi.
            if (event.message.tool_calls?.length) status.thinking()
            break

          case 'context-trimmed':
            status.clear()
            console.log(`  ${theme.muted(`konteks dipangkas: ${event.droppedMessages} pesan lama dibuang (~${event.estimatedTokens} token terkirim)`)}`)
            break

          case 'error':
            status.clear()
            if (streamingText) {
              stdout.write('\n')
              streamingText = false
            }
            console.log(`\n  ${theme.danger('error')} ${event.message}`)
            break

          default:
            break
        }
      }
      status.commit()
    } finally {
      // Sibuk harus selalu dilepas; bila tersangkut, seluruh ketikan
      // berikutnya akan masuk antrean dan sesi tampak membeku.
      busy = false
    }
    stdout.write('\n\n')
  }

  readline.close()
  console.log(`\n  ${theme.accent('Sampai jumpa.')}\n`)
}

await main()
