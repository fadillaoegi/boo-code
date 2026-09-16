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

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const BOO_KEYS = [
  'NINEROUTER_URL',
  'NINEROUTER_KEY',
  'BOO_MODEL',
  'BOO_MAX_CONTEXT_TOKENS',
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
