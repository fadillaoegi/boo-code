/**
 * Membaca kuota langganan dari dashboard 9Router.
 *
 * Kunci API 9Router hanya membuka `/v1/*`; kuota per akun dan per model ada di
 * balik login dashboard (`POST /api/auth/login` dengan password, lalu cookie sesi).
 * Modul ini login sekali, menyimpan cookie itu di memori, dan memakainya ulang.
 *
 * Dua kehati-hatian yang disengaja:
 *
 * - **Tidak pernah mencoba ulang password.** Dashboard mengunci akun setelah
 *   beberapa percobaan gagal, jadi password yang ditolak langsung dilaporkan apa
 *   adanya, termasuk sisa percobaannya.
 * - **Tidak menyentuh kredensial penyedia.** Jawaban `/api/providers` memuat token
 *   akun langganan; yang diambil dari sana hanya nama dan angka kuota. Nilai yang
 *   panjang atau bernama seperti rahasia tidak pernah dibaca, ditampilkan, maupun
 *   disimpan.
 */

import type { QuotaEntry } from './quota.ts'

export const DASHBOARD_LOGIN_PATH = 'api/auth/login'
/** Endpoint yang dipakai halaman Quota Tracker dashboard. */
export const DASHBOARD_QUOTA_PATHS = ['api/providers', 'api/provider-nodes'] as const

export class DashboardError extends Error {
  /** Diisi bila dashboard menyebut sisa percobaan sebelum terkunci. */
  readonly attemptsLeft: number | undefined
  readonly retryAfterSeconds: number | undefined

  constructor(message: string, options: { attemptsLeft?: number; retryAfterSeconds?: number } = {}) {
    super(message)
    this.name = 'DashboardError'
    this.attemptsLeft = options.attemptsLeft
    this.retryAfterSeconds = options.retryAfterSeconds
  }
}

function endpoint(baseUrl: string, path: string): URL {
  return new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`)
}

/** Cookie sesi hasil login, dipakai ulang selama proses Boo hidup. */
const sessions = new Map<string, string>()

/**
 * Login ke dashboard dan mengembalikan cookie sesinya. Password tidak disimpan di
 * modul ini; pemanggil yang memutuskan di mana menyimpannya.
 */
export async function loginToDashboard(baseUrl: string, password: string, timeoutMs = 15_000): Promise<string> {
  if (!password) throw new DashboardError('Password dashboard 9Router belum diisi.')
  let response: Response
  try {
    response = await fetch(endpoint(baseUrl, DASHBOARD_LOGIN_PATH), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ password }),
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    throw new DashboardError(`Tidak dapat menghubungi dashboard 9Router: ${error instanceof Error ? error.message : 'error tak dikenal'}`)
  }

  const body = await response.json().catch(() => ({})) as { error?: string; retryAfter?: number; remainingBeforeLock?: number }
  if (!response.ok) {
    throw new DashboardError(body.error ?? `Dashboard menolak login (HTTP ${response.status}).`, {
      ...(typeof body.remainingBeforeLock === 'number' ? { attemptsLeft: body.remainingBeforeLock } : {}),
      ...(typeof body.retryAfter === 'number' ? { retryAfterSeconds: body.retryAfter } : {}),
    })
  }

  const cookies = response.headers.getSetCookie?.() ?? []
  const session = cookies.map((cookie) => cookie.split(';')[0]).join('; ')
  if (!session) throw new DashboardError('Login berhasil tetapi dashboard tidak mengirim cookie sesi.')
  sessions.set(baseUrl, session)
  return session
}

export function forgetDashboardSession(baseUrl: string): void {
  sessions.delete(baseUrl)
}

async function readJson(baseUrl: string, path: string, session: string, timeoutMs: number): Promise<unknown> {
  const response = await fetch(endpoint(baseUrl, path), {
    headers: { Cookie: session, Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (response.status === 401) throw new DashboardError('Sesi dashboard tidak berlaku lagi.')
  if (!response.ok) throw new DashboardError(`Dashboard membalas HTTP ${response.status} untuk /${path}.`)
  return response.json()
}

/* ------------------------------------------------------------------ parsing */

const SECRET_KEY = /(token|secret|password|key|cookie|authorization|refresh|access|credential|bearer)/i
const LABEL_KEY = /^(name|label|title|alias|model|modelId|account|accountName|email|provider|providerName|id)$/i
const REMAINING_KEY = /(^|_)(remaining|available|left|balance)(_|$)/
const LIMIT_KEY = /(^|_)(limit|quota|max|capacity)(_|$)/
const USED_KEY = /(^|_)(used|usage|consumed|spent|count)(_|$)/
const RESET_KEY = /(reset|refresh|renew|until|expires|expiry|cooldown|next_available)/

/** `quotaLimit` dan `quota_limit` harus dikenali sama; nama field dinormalkan dulu. */
function normalizeKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[\s-]+/g, '_').toLowerCase()
}
const MAX_LABEL_LENGTH = 60

function labelOf(record: Record<string, unknown>): string | null {
  for (const [key, value] of Object.entries(record)) {
    if (!LABEL_KEY.test(key) || SECRET_KEY.test(key)) continue
    if (typeof value !== 'string' || !value.trim()) continue
    // Nilai panjang tanpa spasi biasanya token, bukan nama.
    if (value.length > MAX_LABEL_LENGTH) continue
    return value.trim()
  }
  return null
}

function timestampOf(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value <= 0) return undefined
    // Detik, milidetik, atau durasi relatif dalam detik.
    if (value > 1e12) return value
    if (value > 1e9) return value * 1_000
    return Date.now() + value * 1_000
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Menyusun kuota dari jawaban dashboard tanpa menuntut bentuk tertentu: setiap
 * objek yang punya nama dan angka bernuansa kuota diambil. Ini disengaja, karena
 * bentuk jawaban 9Router dapat berubah antar versi.
 */
export function extractQuotaEntries(payload: unknown, providerId: string): QuotaEntry[] {
  const entries: QuotaEntry[] = []
  const seen = new Set<string>()

  const visit = (node: unknown, depth: number): void => {
    if (depth > 6 || node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1)
      return
    }
    const record = node as Record<string, unknown>
    let remaining: number | undefined
    let limit: number | undefined
    let used: number | undefined
    let resetAt: number | undefined
    let disabled = false
    let statusText: string | undefined

    for (const [rawKey, value] of Object.entries(record)) {
      if (SECRET_KEY.test(rawKey)) continue
      const key = normalizeKey(rawKey)
      if (typeof value === 'boolean' && /(disabled|exhausted|blocked|paused|cooldown)/.test(key) && value) disabled = true
      if (typeof value === 'string' && /^(status|state)$/.test(key) && value.length <= MAX_LABEL_LENGTH) statusText = value
      const asNumber = numberOf(value)
      if (asNumber === undefined) {
        if (RESET_KEY.test(key)) resetAt ??= timestampOf(value)
        continue
      }
      // Urutannya penting: `quota_used` juga cocok dengan pola limit, sehingga
      // pemakaian harus diperiksa lebih dulu agar tidak terbaca sebagai batas.
      if (RESET_KEY.test(key)) resetAt ??= timestampOf(value)
      else if (REMAINING_KEY.test(key)) remaining ??= asNumber
      else if (USED_KEY.test(key)) used ??= asNumber
      else if (LIMIT_KEY.test(key)) limit ??= asNumber
    }

    const label = labelOf(record)
    const hasQuota = remaining !== undefined || limit !== undefined || used !== undefined || resetAt !== undefined
    if (label && hasQuota) {
      const computed = remaining ?? (limit !== undefined && used !== undefined ? Math.max(0, limit - used) : undefined)
      const key = `${label}\u0000${computed ?? ''}\u0000${limit ?? ''}\u0000${resetAt ?? ''}`
      if (!seen.has(key)) {
        seen.add(key)
        entries.push({
          providerId,
          label,
          scope: 'account',
          source: 'dashboard',
          state: disabled ? 'exhausted' : computed === 0 ? 'exhausted' : resetAt && resetAt > Date.now() && computed === undefined ? 'cooldown' : computed === undefined ? 'unknown' : 'ok',
          ...(computed !== undefined ? { remaining: computed } : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...(resetAt !== undefined ? { resetAt } : {}),
          ...(statusText ? { detail: statusText } : {}),
          unit: 'requests',
        })
      }
    }

    for (const value of Object.values(record)) visit(value, depth + 1)
  }

  visit(payload, 0)
  return entries
}

export interface DashboardQuotaOptions {
  baseUrl: string
  password: string
  providerId?: string
  timeoutMs?: number
}

/**
 * Kuota langganan 9Router. Login dilakukan hanya bila belum ada sesi, atau bila
 * sesi yang ada sudah kedaluwarsa.
 */
export async function fetchNineRouterQuota({ baseUrl, password, providerId = 'ninerouter', timeoutMs = 15_000 }: DashboardQuotaOptions): Promise<QuotaEntry[]> {
  let session = sessions.get(baseUrl) ?? await loginToDashboard(baseUrl, password, timeoutMs)
  const entries: QuotaEntry[] = []
  const failures: string[] = []

  for (const path of DASHBOARD_QUOTA_PATHS) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        entries.push(...extractQuotaEntries(await readJson(baseUrl, path, session, timeoutMs), providerId))
        break
      } catch (error) {
        const expired = error instanceof DashboardError && /tidak berlaku lagi/.test(error.message)
        if (expired && attempt === 0) {
          forgetDashboardSession(baseUrl)
          session = await loginToDashboard(baseUrl, password, timeoutMs)
          continue
        }
        failures.push(error instanceof Error ? error.message : 'gagal')
        break
      }
    }
  }

  if (!entries.length && failures.length) throw new DashboardError(failures[0])
  return entries
}
