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
  const model = process.env.BOO_MODEL || DEFAULT_MODEL

  const provider = new NineRouterProvider({
    baseUrl: process.env.NINEROUTER_URL || DEFAULT_BASE_URL,
    apiKey: requireKey(),
    model,
  })

  const readline = createInterface({ input: stdin, output: stdout })

  const agent = new Agent({
    provider,
    registry: createDefaultRegistry(),
    workspace,
    async askPermission({ preview, name }) {
      // Pertanyaan izin sengaja memuat perintah utuh: pengguna menyetujui
      // tindakan yang terlihat, bukan nama tool yang abstrak.
      try {
        const answer = await readline.question(
          `\n  ${theme.danger('izin')} ${theme.bold(name)}  ${preview}\n  ${theme.muted('jalankan? [y/N] ')}`,
        )
        return answer.trim().toLowerCase() === 'y'
      } catch {
        return false // stdin tertutup — anggap tidak diizinkan.
      }
    },
  })

  console.log(`\n${banner()}\n`)
  console.log(`  ${theme.accent('Boo-code')} ${theme.muted(`· ${model} · ${workspace}`)}`)
  console.log(`  ${theme.muted('ketik perintah, atau /keluar untuk berhenti')}\n`)

  for (;;) {
    // readline melempar saat stdin tertutup (Ctrl-D atau input yang dipipe habis);
    // itu akhir sesi yang wajar, bukan kegagalan.
    let input: string
    try {
      input = (await readline.question(`${theme.accentBold('boo')} ${theme.accent('›')} `)).trim()
    } catch {
      break
    }
    if (!input) continue
    if (input === '/keluar' || input === '/exit') break

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
