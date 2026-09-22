/**
 * `boo-code setup`: menyiapkan ~/.boo/.env di mesin baru.
 *
 * Tanpa ini, memasang Boo di mesin lain berarti menulis berkas setelan dengan
 * tangan dan baru tahu kuncinya salah saat pertanyaan pertama gagal. Di sini
 * koneksi ke 9Router diperiksa lebih dulu, dan kunci diketik tanpa tampil di layar.
 */

import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { NineRouterProvider } from '@boo/core'
import { GLOBAL_CONFIG_PATH, updateEnvFile } from '@boo/core/config/config.ts'
import { theme } from './theme.ts'

export const DEFAULT_BASE_URL = 'http://localhost:20128'

const CTRL_C = String.fromCharCode(3)
const BACKSPACE = String.fromCharCode(127)
const CTRL_H = String.fromCharCode(8)

/** Membaca teks rahasia; setiap huruf tampil sebagai bintang. Null bila dibatalkan. */
function askSecret(prompt: string): Promise<string | null> {
  if (!stdin.isTTY) return askLine(prompt)
  return new Promise((resolve) => {
    stdout.write(prompt)
    let value = ''
    const wasRaw = stdin.isRaw
    stdin.setRawMode(true)
    stdin.setEncoding('utf8')
    stdin.resume()
    const finish = (result: string | null) => {
      stdin.off('data', onData)
      stdin.setRawMode(wasRaw)
      stdin.pause()
      stdout.write('\n')
      resolve(result)
    }
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === '\r' || character === '\n') return finish(value)
        if (character === CTRL_C) return finish(null)
        if (character === BACKSPACE || character === CTRL_H) {
          if (value) {
            value = value.slice(0, -1)
            stdout.write('\b \b')
          }
          continue
        }
        if (character.charCodeAt(0) < 32) continue
        value += character
        stdout.write('*')
      }
    }
    stdin.on('data', onData)
  })
}

async function askLine(prompt: string): Promise<string | null> {
  const readline = createInterface({ input: stdin, output: stdout })
  try {
    return await readline.question(prompt)
  } catch {
    return null
  } finally {
    readline.close()
  }
}

export interface SetupDefaults {
  url?: string
  key?: string
  model?: string
}

/** Menjalankan wizard; mengembalikan true bila setelan tersimpan. */
export async function runSetup(defaults: SetupDefaults): Promise<boolean> {
  console.log(`\n  ${theme.accentBold('Setup Boo Code')}`)
  console.log(`  ${theme.muted(`Setelan disimpan di ${GLOBAL_CONFIG_PATH} dan hanya dapat dibaca akunmu.`)}\n`)

  const urlDefault = defaults.url || DEFAULT_BASE_URL
  const urlAnswer = await askLine(`  Alamat 9Router ${theme.muted(`[${urlDefault}]`)}: `)
  if (urlAnswer === null) return false
  const url = urlAnswer.trim() || urlDefault
  try {
    new URL(url)
  } catch {
    console.log(`  ${theme.danger(`"${url}" bukan alamat yang sah.`)}\n`)
    return false
  }

  const keyHint = defaults.key ? theme.muted(' [enter: pakai kunci yang tersimpan]') : theme.muted(' (dari Dashboard 9Router)')
  const keyAnswer = await askSecret(`  Kunci API${keyHint}: `)
  if (keyAnswer === null) return false
  const key = keyAnswer.trim() || defaults.key || ''
  if (!key) {
    console.log(`  ${theme.danger('Kunci API wajib diisi.')}\n`)
    return false
  }

  stdout.write(`  ${theme.muted('Memeriksa koneksi…')}`)
  let models: string[] = []
  try {
    models = await new NineRouterProvider({ baseUrl: url, apiKey: key, model: '', timeoutMs: 15_000 }).listModels()
    stdout.write(`\r  ${theme.accent('✓')} Terhubung ke 9Router · ${models.length} model tersedia\n`)
  } catch (error) {
    stdout.write(`\r  ${theme.danger('✗')} Tidak dapat terhubung: ${error instanceof Error ? error.message : 'error tak dikenal'}\n`)
    const keep = await askLine(`  Simpan setelan ini tetap? ${theme.muted('[y/N]')} `)
    if (keep?.trim().toLowerCase() !== 'y') return false
  }

  const modelDefault = defaults.model && (defaults.model === 'auto' || !models.length || models.includes(defaults.model))
    ? defaults.model
    : 'auto'
  const modelAnswer = await askLine(`  Model bawaan ${theme.muted(`[${modelDefault}]`)}: `)
  if (modelAnswer === null) return false
  const model = modelAnswer.trim() || modelDefault
  if (model !== 'auto' && models.length && !models.includes(model)) {
    console.log(`  ${theme.muted(`Catatan: ${model} tidak ada di daftar model 9Router saat ini.`)}`)
  }

  updateEnvFile(GLOBAL_CONFIG_PATH, { NINEROUTER_URL: url, NINEROUTER_KEY: key, BOO_MODEL: model })
  console.log(`\n  ${theme.accent('✓')} Tersimpan. Model dan tingkat penalaran dapat diganti kapan saja dengan /model.\n`)
  return true
}
