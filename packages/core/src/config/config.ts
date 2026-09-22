/**
 * Resolusi konfigurasi untuk pemasangan global.
 *
 * Saat dijalankan lewat `pnpm boo` di dalam repo, kunci dibaca dari `.env.local`
 * milik repo. Setelah dipasang global, `boo` berjalan di direktori mana pun dan
 * tidak punya berkas itu, sehingga konfigurasi dicari berlapis:
 *
 *   1. ~/.boo/.env          — setelan tetap milik pengguna
 *   2. <workspace>/.env     — setelan proyek
 *   3. <workspace>/.env.local
 *   4. environment variable — selalu menang
 *
 * Hanya kunci milik Boo yang diambil. Berkas `.env` proyek lazim memuat rahasia
 * aplikasi lain, dan tidak ada alasan memuatnya ke dalam proses ini.
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const BOO_KEYS = [
  'NINEROUTER_URL',
  'NINEROUTER_KEY',
  /** Password dashboard 9Router; hanya dipakai membaca sisa kuota langganan. */
  'NINEROUTER_DASHBOARD_PASSWORD',
  // Penyedia model selain 9Router; definisinya ada di provider/profiles.ts.
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'OPENROUTER_API_KEY',
  'OPENROUTER_BASE_URL',
  'OLLAMA_API_KEY',
  'OLLAMA_BASE_URL',
  'CUSTOM_API_KEY',
  'CUSTOM_API_URL',
  'BOO_MODEL',
  'BOO_EFFORT',
  'BOO_MAX_CONTEXT_TOKENS',
  'BOO_MAX_TURNS',
  'BOO_SANDBOX',
  'BOO_NETWORK_ACCESS',
  'BOO_TRACE',
  'BOO_AUTO_REVIEW',
] as const

export type BooKey = (typeof BOO_KEYS)[number]

/** Lokasi berkas setelan global, ditampilkan pada pesan bantuan. */
export const GLOBAL_CONFIG_PATH = join(homedir(), '.boo', '.env')

/** Membaca KEY=VALUE sederhana; tanda kutip dilepas, komentar dilewati. */
function parseEnvFile(path: string): Partial<Record<BooKey, string>> {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return {}
  }

  const found: Partial<Record<BooKey, string>> = {}
  for (const line of raw.split('\n')) {
    const text = line.trim()
    if (!text || text.startsWith('#')) continue
    const separator = text.indexOf('=')
    if (separator === -1) continue

    const key = text.slice(0, separator).trim()
    if (!(BOO_KEYS as readonly string[]).includes(key)) continue

    let value = text.slice(separator + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    found[key as BooKey] = value
  }
  return found
}

/**
 * Menggabungkan seluruh sumber setelan. Berkas yang dibaca belakangan menimpa
 * yang sebelumnya, dan environment variable yang sudah ada selalu menang supaya
 * `NINEROUTER_KEY=... boo` tetap dapat dipakai sekali jalan.
 */
export function loadConfig(workspace: string): Record<BooKey, string | undefined> {
  const merged: Partial<Record<BooKey, string>> = {
    ...parseEnvFile(GLOBAL_CONFIG_PATH),
    ...parseEnvFile(join(workspace, '.env')),
    ...parseEnvFile(join(workspace, '.env.local')),
  }

  const resolved = {} as Record<BooKey, string | undefined>
  for (const key of BOO_KEYS) resolved[key] = process.env[key] || merged[key]
  return resolved
}

/**
 * Menulis setelan ke berkas .env tanpa membuang isi lain: baris kunci yang sudah
 * ada diganti di tempatnya, yang belum ada ditambahkan di akhir. Berkasnya memuat
 * kunci API, jadi hanya dapat dibaca pemiliknya.
 */
export function updateEnvFile(path: string, values: Partial<Record<BooKey, string>>): void {
  let lines: string[] = []
  try {
    lines = readFileSync(path, 'utf8').split('\n')
    if (lines.at(-1) === '') lines.pop()
  } catch {
    // Berkas belum ada.
  }
  const pending = new Map(Object.entries(values).filter(([, value]) => value !== undefined) as [string, string][])
  lines = lines.map((line) => {
    const key = line.split('=')[0].trim()
    if (line.trim().startsWith('#') || !pending.has(key)) return line
    const value = pending.get(key)!
    pending.delete(key)
    return `${key}=${value}`
  })
  for (const [key, value] of pending) lines.push(`${key}=${value}`)

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${lines.join('\n')}\n`, { mode: 0o600 })
  // Mode pada writeFileSync hanya berlaku untuk berkas baru.
  chmodSync(path, 0o600)
}
