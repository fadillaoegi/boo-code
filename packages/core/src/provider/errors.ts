/**
 * Kegagalan memanggil model, dipakai semua penyedia.
 *
 * Dipisahkan dari adapter 9Router agar adapter lain — Anthropic, OpenAI, penyedia
 * OpenAI-compatible — memakai klasifikasi dan aturan pengulangan yang sama.
 */

/** Status yang biasanya pulih sendiri: limit, dan gangguan di sisi server. */
const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504, 529])
/** Jeda dari 9Router lebih lama dari ini tidak ditunggu otomatis. */
const MAX_RETRY_AFTER_MS = 60_000

/**
 * Kegagalan memanggil model, beserta apakah layak diulang.
 *
 * 9Router membungkus error provider di pesannya — `[codex/gpt-5.6] [429]: …` —
 * dan menambahkan `(reset after 20s)` pada error apa pun, termasuk permintaan
 * yang memang salah. Karena itu keputusan mengulang diambil dari status, bukan
 * dari ada-tidaknya jeda: permintaan 400 yang diulang hanya gagal lagi.
 */
export class ProviderError extends Error {
  readonly status: number | undefined
  readonly retryable: boolean
  /** Jeda yang diminta 9Router sebelum model ini dapat dipakai lagi. */
  readonly retryAfterMs: number | undefined

  constructor(message: string, options: { status?: number; retryable: boolean; retryAfterMs?: number }) {
    super(message)
    this.name = 'ProviderError'
    this.status = options.status
    this.retryable = options.retryable
    this.retryAfterMs = options.retryAfterMs
  }
}

/** Mengklasifikasikan respons HTTP yang gagal. */
export function httpError(rawBody: string, status: number): ProviderError {
  let message = errorMessage(rawBody, status)
  // Status provider di dalam pesan lebih jujur daripada status HTTP 9Router sendiri.
  const inner = /\[(\d{3})\]:/.exec(message)
  const effective = inner ? Number(inner[1]) : status
  const reset = /reset after (\d+)\s*s/i.exec(message)
  const retryAfterMs = reset ? Number(reset[1]) * 1_000 : undefined
  const retryable = TRANSIENT_STATUS.has(effective) && (retryAfterMs === undefined || retryAfterMs <= MAX_RETRY_AFTER_MS)
  if (effective === 400 && /(?:image|vision|multimodal|image_url)/i.test(message)) {
    message = `${message}\nModel ini mungkin tidak mendukung input gambar; pilih model vision-capable atau gunakan mode Auto.`
  }
  return new ProviderError(message, { status: effective, retryable, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) })
}

/** Koneksi putus atau tidak ada data sama sekali selama batas waktu: layak diulang. */
export function connectionError(error: unknown, idle: boolean): ProviderError {
  if (idle) return new ProviderError('9Router tidak mengirim data apa pun terlalu lama.', { retryable: true })
  const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : ''
  const detail = error instanceof Error ? error.message : 'error tak dikenal'
  return new ProviderError(`Koneksi ke 9Router gagal (${detail}${cause}).`, { retryable: true })
}

export function errorMessage(rawBody: string, status: number): string {
  try {
    const parsed = JSON.parse(rawBody) as { error?: { message?: string } }
    return parsed.error?.message || `9Router merespons HTTP ${status}.`
  } catch {
    return `9Router merespons HTTP ${status}.`
  }
}
