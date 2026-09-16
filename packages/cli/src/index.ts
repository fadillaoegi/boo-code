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
import { Agent, createDefaultRegistry, NineRouterProvider } from '@boo/core'
import { banner, theme } from './theme.ts'

const DEFAULT_MODEL = 'ag/claude-sonnet-4-6'
const DEFAULT_BASE_URL = 'http://localhost:20128'

const HELP = `  /model          ganti model AI
  /model <id>     ganti langsung ke model tertentu
  /help           tampilkan bantuan ini
  /keluar         akhiri sesi`

/** Membaca --model dari argumen baris perintah. */
function modelFromArgs(): string | undefined {
  const args = process.argv.slice(2)
  const index = args.findIndex((arg) => arg === '--model' || arg === '-m')
  if (index !== -1 && args[index + 1]) return args[index + 1]
  const inline = args.find((arg) => arg.startsWith('--model='))
  return inline?.slice('--model='.length)
}

function requireKey(): string {
  const key = process.env.NINEROUTER_KEY
  if (key) return key
  console.error(theme.danger('NINEROUTER_KEY belum di-set.'))
  console.error(theme.muted('Salin .env.example menjadi .env.local lalu isi key dari Dashboard 9Router.'))
  process.exit(1)
}

/** Memangkas keluaran tool agar terminal tidak tenggelam oleh isi file. */
function summarize(content: string, maxLines = 6): string {
  const lines = content.split('\n')
  if (lines.length <= maxLines) return lines.map((line) => `    ${line}`).join('\n')
  const shown = lines.slice(0, maxLines).map((line) => `    ${line}`).join('\n')
  return `${shown}\n    ${theme.muted(`… ${lines.length - maxLines} baris lagi`)}`
}

async function main() {
  const workspace = process.cwd()
  // Urutan prioritas: flag baris perintah, lalu .env.local, lalu bawaan.
  const model = modelFromArgs() || process.env.BOO_MODEL || DEFAULT_MODEL

  const provider = new NineRouterProvider({
    baseUrl: process.env.NINEROUTER_URL || DEFAULT_BASE_URL,
    apiKey: requireKey(),
    model,
  })

  const readline = createInterface({ input: stdin, output: stdout })

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

  readline.on('line', (line) => {
    const waiter = waiting.shift()
    if (waiter) waiter(line)
    else buffered.push(line)
  })
  readline.on('close', () => {
    ended = true
    while (waiting.length) waiting.shift()?.(null)
  })

  function ask(prompt: string): Promise<string | null> {
    stdout.write(prompt)
    const queued = buffered.shift()
    if (queued !== undefined) {
      stdout.write(`${queued}\n`)
      return Promise.resolve(queued)
    }
    if (ended) return Promise.resolve(null)
    return new Promise((resolve) => waiting.push(resolve))
  }

  const agent = new Agent({
    provider,
    registry: createDefaultRegistry(),
    workspace,
    async askPermission({ preview, name }) {
      // Pertanyaan izin sengaja memuat perintah utuh: pengguna menyetujui
      // tindakan yang terlihat, bukan nama tool yang abstrak.
      const answer = await ask(
        `\n  ${theme.danger('izin')} ${theme.bold(name)}  ${preview}\n  ${theme.muted('jalankan? [y/N] ')}`,
      )
      // null berarti stdin tertutup; perlakukan sebagai tidak diizinkan.
      return answer?.trim().toLowerCase() === 'y'
    },
  })

  /** Mengganti model sesi berjalan; riwayat percakapan tetap dipertahankan. */
  async function changeModel(requested: string): Promise<void> {
    if (requested) {
      provider.model = requested
      console.log(`  ${theme.accent('model')} ${theme.bold(requested)}\n`)
      return
    }

    let available: string[]
    try {
      available = await provider.listModels()
    } catch (error) {
      console.log(`  ${theme.danger('error')} ${error instanceof Error ? error.message : 'gagal'}\n`)
      return
    }
    if (!available.length) {
      console.log(`  ${theme.muted('9Router tidak mengembalikan model apa pun.')}\n`)
      return
    }

    console.log()
    available.forEach((id, index) => {
      const active = id === provider.model ? theme.accent(' ← aktif') : ''
      console.log(`  ${theme.muted(String(index + 1).padStart(3))}  ${id}${active}`)
    })

    const answer = (await ask(`\n  ${theme.muted('nomor model [enter untuk batal] ')}`))?.trim()
    if (!answer) {
      console.log()
      return
    }

    const choice = Number(answer)
    const picked = Number.isInteger(choice) && choice >= 1 && choice <= available.length
      ? available[choice - 1]
      : available.includes(answer) ? answer : null
    if (!picked) {
      console.log(`  ${theme.danger('pilihan tidak dikenal')}\n`)
      return
    }
    provider.model = picked
    console.log(`  ${theme.accent('model')} ${theme.bold(picked)}\n`)
  }

  console.log(`\n${banner()}\n`)
  console.log(`  ${theme.accent('Boo Code')} ${theme.muted(`· ${model} · ${workspace}`)}`)
  console.log(`  ${theme.muted('ketik perintah, /help untuk daftar perintah')}\n`)

  for (;;) {
    const answer = await ask(`${theme.accentBold('boo')} ${theme.accent('›')} `)
    if (answer === null) break
    const input = answer.trim()
    if (!input) continue
    if (input === '/keluar' || input === '/exit') break
    if (input === '/help') {
      console.log(`\n${HELP}\n`)
      continue
    }
    if (input === '/model' || input.startsWith('/model ')) {
      await changeModel(input.slice('/model'.length).trim())
      continue
    }

    let streamingText = false
    for await (const event of agent.send(input)) {
      switch (event.type) {
        case 'text':
          if (!streamingText) {
            stdout.write('\n  ')
            streamingText = true
          }
          stdout.write(event.delta.replace(/\n/g, '\n  '))
          break
        case 'tool-start':
          if (streamingText) { stdout.write('\n'); streamingText = false }
          console.log(`\n  ${theme.accent('⏺')} ${theme.bold(event.name)}  ${theme.muted(event.preview)}`)
          break
        case 'tool-end':
          console.log(event.isError
            ? `${theme.danger('    gagal')}\n${summarize(event.content)}`
            : summarize(event.content))
          break
        case 'context-trimmed':
          console.log(`  ${theme.muted(`konteks dipangkas: ${event.droppedMessages} pesan lama dibuang (~${event.estimatedTokens} token terkirim)`)}`)
          break
        case 'tool-denied':
          console.log(`  ${theme.muted(`${event.name} dilewati`)}`)
          break
        case 'error':
          if (streamingText) { stdout.write('\n'); streamingText = false }
          console.log(`\n  ${theme.danger('error')} ${event.message}`)
          break
        default:
          break
      }
    }
    stdout.write('\n\n')
  }

  readline.close()
  console.log(`\n  ${theme.accent('Sampai jumpa.')}\n`)
}

await main()
