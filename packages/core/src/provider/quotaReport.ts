/**
 * Menggabungkan sisa limit dari semua sumber yang tersedia.
 *
 * Tidak ada penyedia yang melaporkan semuanya, jadi laporan ini selalu menyebut
 * dari mana angkanya berasal, dan menjelaskan apa yang memang tidak dapat
 * diketahui — lebih baik daripada menampilkan angka yang terlihat pasti padahal
 * hasil tebakan.
 */

import { fetchNineRouterQuota } from './nineRouterDashboard.ts'
import type { ProviderProfile } from './profiles.ts'
import { fetchOpenRouterCredits, quotaTracker, type QuotaEntry, type UsageEntry } from './quota.ts'

export interface QuotaReport {
  entries: QuotaEntry[]
  usage: UsageEntry[]
  /** Keterangan untuk pengguna, misalnya sumber yang belum dikonfigurasi. */
  notes: string[]
}

export interface GatherQuotaOptions {
  profiles: readonly ProviderProfile[]
  /** Setelan; dipakai mengambil password dashboard 9Router bila ada. */
  config: Partial<Record<string, string | undefined>>
  signal?: AbortSignal
}

export async function gatherQuota({ profiles, config, signal }: GatherQuotaOptions): Promise<QuotaReport> {
  const entries: QuotaEntry[] = []
  const notes: string[] = []

  await Promise.all(profiles.map(async (profile) => {
    if (profile.id === 'openrouter') {
      try {
        const credits = await fetchOpenRouterCredits(profile, 10_000, signal)
        if (credits) entries.push(credits)
      } catch (error) {
        notes.push(`Saldo OpenRouter tidak terbaca: ${error instanceof Error ? error.message : 'gagal'}`)
      }
      return
    }
    if (profile.id !== 'ninerouter') return

    const password = (config.NINEROUTER_DASHBOARD_PASSWORD ?? '').trim()
    if (!password) {
      notes.push('9Router tidak melaporkan kuota lewat kunci API. Isi password dashboard (boo-code setup) untuk membaca sisa kuota langganan.')
      return
    }
    try {
      entries.push(...await fetchNineRouterQuota({ baseUrl: profile.baseUrl, password, providerId: profile.id }))
    } catch (error) {
      notes.push(`Kuota dashboard 9Router tidak terbaca: ${error instanceof Error ? error.message : 'gagal'}`)
    }
  }))

  // Yang diamati sendiri melengkapi, bukan menimpa: model yang sudah punya angka
  // dari dashboard tidak perlu baris kedua kecuali sedang cooldown.
  const known = new Set(entries.map((entry) => `${entry.providerId}\u0000${entry.label}`))
  for (const observed of quotaTracker.entries()) {
    if (known.has(`${observed.providerId}\u0000${observed.label}`) && observed.state !== 'cooldown') continue
    entries.push(observed)
  }

  return { entries, usage: quotaTracker.usageEntries(), notes }
}
