/**
 * Sisa limit dan pemakaian model.
 *
 * Tidak ada satu sumber yang tahu semuanya, jadi yang ditampilkan Boo digabung dari
 * empat sumber dan selalu disebutkan asalnya:
 *
 * - **headers** — OpenAI dan Anthropic mengirim sisa jatah per menit di header
 *   setiap respons. Ini jatah laju, bukan saldo.
 * - **credits** — OpenRouter punya endpoint saldo untuk kunci itu sendiri.
 * - **dashboard** — 9Router menyimpan kuota langganannya di balik login dashboard;
 *   lihat `nineRouterDashboard`.
 * - **observed** — sisanya hanya dapat diketahui dari apa yang benar-benar terjadi:
 *   model yang menolak dengan pesan cooldown, dan hitungan pemakaian kita sendiri.
 *   Hitungan token di sini perkiraan, karena 9Router tidak melaporkan pemakaian.
 *
 * Tidak ada database: semuanya di memori proses, hilang saat Boo ditutup.
 */

import { estimateTextTokens } from '../agent/context.ts'
import type { ProviderProfile } from './profiles.ts'

export type QuotaUnit = 'requests' | 'tokens' | 'credits' | 'usd'
export type QuotaSource = 'headers' | 'credits' | 'dashboard' | 'observed'
export type QuotaState = 'ok' | 'cooldown' | 'exhausted' | 'unknown'

export interface QuotaEntry {
  providerId: string
  /** Model, atau nama akun bila kuotanya milik akun. */
  label: string
  scope: 'model' | 'account'
  state: QuotaState
  source: QuotaSource
  remaining?: number
  limit?: number
  unit?: QuotaUnit
  /** Waktu jatah pulih, dalam epoch milidetik. */
  resetAt?: number
  detail?: string
}

/** Pemakaian yang tercatat Boo sendiri di mesin ini. */
export interface UsageEntry {
  providerId: string
  model: string
  requests: number
  failures: number
  /** Perkiraan, dihitung dari panjang teks; penyedia tidak selalu melaporkannya. */
  inputTokens: number
  outputTokens: number
  lastUsedAt: number
  /** Cooldown terakhir yang dilaporkan penyedia. */
  cooldownUntil?: number
  cooldownReason?: string
}

function number(value: string | null): number | undefined {
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** `30s`, `2m30s`, atau detik polos menjadi milidetik. */
export function parseResetDuration(value: string | null): number | undefined {
  if (!value) return undefined
  const plain = Number(value)
  if (Number.isFinite(plain)) return plain * 1_000
  const match = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/.exec(value.trim())
  if (!match || !match.slice(1).some(Boolean)) {
    const stamp = Date.parse(value)
    return Number.isFinite(stamp) ? Math.max(0, stamp - Date.now()) : undefined
  }
  const [, hours, minutes, seconds] = match
  return ((Number(hours ?? 0) * 3_600) + (Number(minutes ?? 0) * 60) + Number(seconds ?? 0)) * 1_000
}

export interface RateLimitReading {
  remaining?: number
  limit?: number
  unit?: QuotaUnit
  resetAt?: number
}

/**
 * Membaca header sisa jatah. OpenAI memakai `x-ratelimit-*`, Anthropic
 * `anthropic-ratelimit-*`; keduanya melaporkan sisa permintaan dan sisa token.
 * Yang ditampilkan yang paling menekan: persentase sisa terkecil.
 */
export function readRateLimitHeaders(headers: Headers): RateLimitReading | null {
  const get = (...names: string[]) => {
    for (const name of names) {
      const value = headers.get(name)
      if (value !== null) return value
    }
    return null
  }
  const candidates: RateLimitReading[] = []
  const requests = {
    remaining: number(get('x-ratelimit-remaining-requests', 'anthropic-ratelimit-requests-remaining')),
    limit: number(get('x-ratelimit-limit-requests', 'anthropic-ratelimit-requests-limit')),
    reset: parseResetDuration(get('x-ratelimit-reset-requests')) ?? parseResetDuration(get('anthropic-ratelimit-requests-reset')),
  }
  const tokens = {
    remaining: number(get('x-ratelimit-remaining-tokens', 'anthropic-ratelimit-tokens-remaining')),
    limit: number(get('x-ratelimit-limit-tokens', 'anthropic-ratelimit-tokens-limit')),
    reset: parseResetDuration(get('x-ratelimit-reset-tokens')) ?? parseResetDuration(get('anthropic-ratelimit-tokens-reset')),
  }
  if (requests.remaining !== undefined) {
    candidates.push({ remaining: requests.remaining, ...(requests.limit !== undefined ? { limit: requests.limit } : {}), unit: 'requests', ...(requests.reset !== undefined ? { resetAt: Date.now() + requests.reset } : {}) })
  }
  if (tokens.remaining !== undefined) {
    candidates.push({ remaining: tokens.remaining, ...(tokens.limit !== undefined ? { limit: tokens.limit } : {}), unit: 'tokens', ...(tokens.reset !== undefined ? { resetAt: Date.now() + tokens.reset } : {}) })
  }
  if (!candidates.length) return null
  const share = (reading: RateLimitReading) => reading.limit ? (reading.remaining ?? 0) / reading.limit : 1
  return candidates.sort((a, b) => share(a) - share(b))[0]
}

/**
 * Mencatat apa yang terjadi pada setiap permintaan model, lalu menyajikannya
 * sebagai sisa limit dan pemakaian. Satu untuk seluruh proses Boo.
 */
export class QuotaTracker {
  private readonly usage = new Map<string, UsageEntry>()
  private readonly readings = new Map<string, RateLimitReading>()

  private static key(providerId: string, model: string): string {
    return `${providerId}\u0000${model}`
  }

  private entry(providerId: string, model: string): UsageEntry {
    const key = QuotaTracker.key(providerId, model)
    const existing = this.usage.get(key)
    if (existing) return existing
    const created: UsageEntry = { providerId, model, requests: 0, failures: 0, inputTokens: 0, outputTokens: 0, lastUsedAt: 0 }
    this.usage.set(key, created)
    return created
  }

  /** Dipanggil adapter setelah permintaan berhasil dikirim. */
  recordRequest(providerId: string, model: string, headers?: Headers): void {
    const entry = this.entry(providerId, model)
    entry.requests += 1
    entry.lastUsedAt = Date.now()
    delete entry.cooldownUntil
    delete entry.cooldownReason
    const reading = headers ? readRateLimitHeaders(headers) : null
    if (reading) this.readings.set(QuotaTracker.key(providerId, model), reading)
  }

  /** Token masuk dan keluar; perkiraan bila penyedia tidak melaporkannya. */
  recordTokens(providerId: string, model: string, inputText: string, outputText: string): void {
    const entry = this.entry(providerId, model)
    entry.inputTokens += estimateTextTokens(inputText)
    entry.outputTokens += estimateTextTokens(outputText)
  }

  /** Model menolak; `retryAfterMs` diisi bila penyedia menyebut kapan pulih. */
  recordFailure(providerId: string, model: string, message: string, retryAfterMs?: number): void {
    const entry = this.entry(providerId, model)
    entry.failures += 1
    entry.lastUsedAt = Date.now()
    if (retryAfterMs === undefined) return
    entry.cooldownUntil = Date.now() + retryAfterMs
    entry.cooldownReason = message.slice(0, 200)
  }

  usageEntries(): UsageEntry[] {
    return [...this.usage.values()].sort((a, b) => b.lastUsedAt - a.lastUsedAt)
  }

  /** Sisa limit yang diketahui dari permintaan yang sudah berjalan. */
  entries(): QuotaEntry[] {
    const now = Date.now()
    return this.usageEntries().map((usage) => {
      const reading = this.readings.get(QuotaTracker.key(usage.providerId, usage.model))
      const cooling = usage.cooldownUntil !== undefined && usage.cooldownUntil > now
      const base: QuotaEntry = {
        providerId: usage.providerId,
        label: usage.model,
        scope: 'model',
        state: cooling ? 'cooldown' : reading?.remaining === 0 ? 'exhausted' : reading ? 'ok' : 'unknown',
        source: reading ? 'headers' : 'observed',
      }
      if (cooling) {
        base.resetAt = usage.cooldownUntil
        if (usage.cooldownReason) base.detail = usage.cooldownReason
        return base
      }
      if (!reading) return base
      return {
        ...base,
        remaining: reading.remaining,
        ...(reading.limit !== undefined ? { limit: reading.limit } : {}),
        ...(reading.unit ? { unit: reading.unit } : {}),
        ...(reading.resetAt !== undefined ? { resetAt: reading.resetAt } : {}),
      }
    })
  }

  reset(): void {
    this.usage.clear()
    this.readings.clear()
  }
}

/** Satu pelacak untuk seluruh proses; adapter menulis, tampilan membaca. */
export const quotaTracker = new QuotaTracker()

/**
 * Saldo kunci OpenRouter. Satu-satunya penyedia di daftar Boo yang memberi sisa
 * saldo langsung dari kunci API-nya sendiri.
 */
export async function fetchOpenRouterCredits(profile: ProviderProfile, timeoutMs = 10_000, signal?: AbortSignal): Promise<QuotaEntry | null> {
  const base = profile.baseUrl.endsWith('/') ? profile.baseUrl : `${profile.baseUrl}/`
  const response = await fetch(new URL('key', base), {
    headers: { Authorization: `Bearer ${profile.apiKey}`, Accept: 'application/json' },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) return null
  const body = await response.json() as { data?: { usage?: number; limit?: number | null; limit_remaining?: number | null; is_free_tier?: boolean } }
  const data = body.data
  if (!data) return null
  const remaining = data.limit_remaining ?? (data.limit === null || data.limit === undefined ? undefined : data.limit - (data.usage ?? 0))
  return {
    providerId: profile.id,
    label: data.is_free_tier ? 'Kunci OpenRouter (tier gratis)' : 'Kunci OpenRouter',
    scope: 'account',
    source: 'credits',
    state: remaining === undefined ? 'unknown' : remaining > 0 ? 'ok' : 'exhausted',
    ...(remaining !== undefined ? { remaining } : {}),
    ...(data.limit !== null && data.limit !== undefined ? { limit: data.limit } : {}),
    unit: 'usd',
    detail: data.limit === null || data.limit === undefined ? 'tanpa batas kredit; pemakaian dihitung per permintaan' : undefined,
  }
}
