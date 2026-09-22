/**
 * `boo-code setup`: menyiapkan ~/.boo/.env di mesin baru.
 *
 * Tanpa ini, memasang Boo di mesin lain berarti menulis berkas setelan dengan
 * tangan dan baru tahu kuncinya salah saat pertanyaan pertama gagal. Di sini
 * koneksi ke 9Router diperiksa lebih dulu, dan kunci diketik tanpa tampil di layar.
 */

import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import {
  listAnthropicModels,
  NineRouterProvider,
  PROVIDER_DEFINITIONS,
  profilesFromConfig,
  qualifyModelId,
  type ProviderDefinition,
  type ProviderProfile,
} from '@boo/core'
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
  /** Setelan yang sudah ada, agar penyedia yang terpasang dapat ditandai. */
  config?: Record<string, string | undefined>
}

/** Nilai setelan yang akan ditulis ke ~/.boo/.env. */
type Settings = Record<string, string>

function describeConfigured(definition: ProviderDefinition, config: Record<string, string | undefined>): string {
  const profiles = profilesFromConfig(config)
  return profiles.some((profile) => profile.id === definition.id) ? theme.accent(' · terpasang') : ''
}

/** Memeriksa koneksi satu penyedia; mengembalikan daftar model yang terbaca. */
async function probe(profile: ProviderProfile): Promise<string[]> {
  if (profile.wire === 'anthropic') return listAnthropicModels(profile, 15_000)
  return new NineRouterProvider({ baseUrl: profile.baseUrl, apiKey: profile.apiKey, profiles: [profile], model: '', timeoutMs: 15_000 }).listModels()
}

/**
 * Menambahkan satu penyedia: alamat, kunci (tanpa tampil di layar), lalu
 * pemeriksaan koneksi. Mengembalikan setelan yang perlu ditulis, atau null bila
 * dibatalkan.
 */
async function addProvider(definition: ProviderDefinition, config: Record<string, string | undefined>): Promise<{ settings: Settings; models: string[] } | null> {
  console.log(`\n  ${theme.accentBold(definition.label)} ${theme.muted(`· ${definition.hint}`)}`)

  const urlDefault = (config[definition.urlName] ?? '').trim() || definition.defaultBaseUrl
  const urlAnswer = await askLine(`  Alamat API ${theme.muted(urlDefault ? `[${urlDefault}]` : '(wajib diisi)')}: `)
  if (urlAnswer === null) return null
  const url = urlAnswer.trim() || urlDefault
  if (!url) {
    console.log(`  ${theme.danger('Alamat API wajib diisi untuk penyedia ini.')}`)
    return null
  }
  try {
    new URL(url)
  } catch {
    console.log(`  ${theme.danger(`"${url}" bukan alamat yang sah.`)}`)
    return null
  }

  const existingKey = (config[definition.keyName] ?? '').trim()
  const keyHint = existingKey
    ? ' [enter: pakai kunci yang tersimpan]'
    : definition.keyRequired ? ` (dari ${definition.keySource})` : ' [enter: tanpa kunci]'
  const keyAnswer = await askSecret(`  Kunci API${theme.muted(keyHint)}: `)
  if (keyAnswer === null) return null
  const key = keyAnswer.trim() || existingKey
  if (!key && definition.keyRequired) {
    console.log(`  ${theme.danger('Kunci API wajib diisi untuk penyedia ini.')}`)
    return null
  }

  const profile: ProviderProfile = { id: definition.id, label: definition.label, baseUrl: url, apiKey: key, wire: definition.wire }
  stdout.write(`  ${theme.muted('Memeriksa koneksi…')}`)
  let models: string[] = []
  try {
    models = await probe(profile)
    stdout.write(`\r  ${theme.accent('✓')} Terhubung ke ${definition.label} · ${models.length} model tersedia\n`)
  } catch (error) {
    stdout.write(`\r  ${theme.danger('✗')} Tidak dapat terhubung: ${error instanceof Error ? error.message : 'error tak dikenal'}\n`)
    const keep = await askLine(`  Simpan setelan ini tetap? ${theme.muted('[y/N]')} `)
    if (keep?.trim().toLowerCase() !== 'y') return null
  }

  return {
    settings: { [definition.urlName]: url, ...(key ? { [definition.keyName]: key } : {}) },
    models: models.map((id) => qualifyModelId(definition.id, id)),
  }
}

/**
 * Wizard setup: memasang satu atau beberapa penyedia model, lalu memilih model
 * bawaan. Mengembalikan true bila ada setelan yang tersimpan.
 */
export async function runSetup(defaults: SetupDefaults): Promise<boolean> {
  console.log(`\n  ${theme.accentBold('Setup Boo Code')}`)
  console.log(`  ${theme.muted(`Setelan disimpan di ${GLOBAL_CONFIG_PATH} dan hanya dapat dibaca akunmu.`)}`)
  console.log(`  ${theme.muted('Kunci langganan Codex CLI dan Claude Code tidak dipakai; gunakan kunci API resmi atau 9Router.')}`)

  const config: Record<string, string | undefined> = {
    ...defaults.config,
    ...(defaults.url ? { NINEROUTER_URL: defaults.url } : {}),
    ...(defaults.key ? { NINEROUTER_KEY: defaults.key } : {}),
  }
  const settings: Settings = {}
  const models: string[] = []
  let added = 0

  for (;;) {
    console.log(`\n  ${theme.bold('Penyedia model')}`)
    PROVIDER_DEFINITIONS.forEach((definition, index) => {
      console.log(`  ${theme.muted(String(index + 1).padStart(3))}  ${definition.label}${describeConfigured(definition, config)} ${theme.muted(`· ${definition.hint}`)}`)
    })
    const prompt = added || profilesFromConfig(config).length
      ? `\n  ${theme.muted('nomor penyedia [enter: lanjut ke model] ')}`
      : `\n  ${theme.muted('nomor penyedia [enter: batal] ')}`
    const answer = (await askLine(prompt))?.trim()
    if (!answer) break
    const choice = Number(answer)
    const definition = Number.isInteger(choice) ? PROVIDER_DEFINITIONS[choice - 1] : undefined
    if (!definition) {
      console.log(`  ${theme.danger('Pilihan tidak dikenal.')}`)
      continue
    }
    const result = await addProvider(definition, config)
    if (!result) continue
    Object.assign(settings, result.settings)
    Object.assign(config, result.settings)
    models.push(...result.models)
    added += 1
  }

  if (!added && !Object.keys(settings).length) {
    console.log(`\n  ${theme.muted('Tidak ada yang diubah.')}\n`)
    return false
  }

  // "auto" membiarkan Boo memilih model per permintaan; itu bawaan yang aman.
  const modelDefault = defaults.model && (defaults.model === 'auto' || !models.length || models.includes(defaults.model))
    ? defaults.model
    : 'auto'
  console.log(`\n  ${theme.muted('Model bawaan: "auto" membiarkan Boo memilih sendiri per permintaan.')}`)
  if (models.length) console.log(`  ${theme.muted(`Contoh: ${models.slice(0, 3).join(', ')}`)}`)
  const modelAnswer = await askLine(`  Model bawaan ${theme.muted(`[${modelDefault}]`)}: `)
  const model = (modelAnswer ?? '').trim() || modelDefault
  if (model !== 'auto' && models.length && !models.includes(model)) {
    console.log(`  ${theme.muted(`Catatan: ${model} tidak ada di daftar model penyedia yang baru dipasang.`)}`)
  }

  updateEnvFile(GLOBAL_CONFIG_PATH, { ...settings, BOO_MODEL: model })
  console.log(`\n  ${theme.accent('✓')} Tersimpan. Model dan tingkat penalaran dapat diganti kapan saja dengan /model.\n`)
  return true
}
