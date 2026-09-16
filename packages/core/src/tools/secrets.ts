/**
 * Daftar tolak file rahasia.
 *
 * Apa pun yang dibaca tool akan dikirim ke provider model. File kredensial
 * karena itu ditolak di lapisan tool, bukan diserahkan pada kebijaksanaan model:
 * model tidak tahu file mana yang berbahaya, dan sekali isinya terkirim ia tidak
 * bisa ditarik kembali.
 *
 * Penolakan ini bukan jaminan mutlak. `bash` tetap dapat membaca file apa pun
 * lewat perintah seperti `cat .env`, dan itu disengaja: perintah shell selalu
 * ditampilkan utuh saat meminta izin, sehingga pengguna dapat melihat dan
 * menolaknya sendiri.
 */

import { basename } from 'node:path'

/** Berkas contoh aman dibaca dan justru berguna sebagai rujukan struktur. */
const SAFE_SUFFIXES = ['.example', '.sample', '.template', '.dist']

const SENSITIVE_NAMES = new Set([
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.git-credentials',
  '.htpasswd',
  'credentials',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
])

const SENSITIVE_PATTERNS: RegExp[] = [
  /^\.env(\..+)?$/i,
  /\.pem$/i,
  /\.key$/i,
  /\.pfx$/i,
  /\.p12$/i,
  /\.keystore$/i,
  /\.jks$/i,
  /^.*service[-_]?account.*\.json$/i,
  /^secrets?\.(json|ya?ml|toml|ini)$/i,
]

/**
 * Menentukan apakah sebuah path menunjuk file kredensial.
 * Pemeriksaan memakai nama berkas saja agar berlaku di direktori mana pun.
 */
export function isSensitivePath(path: string): boolean {
  const name = basename(path)
  if (SAFE_SUFFIXES.some((suffix) => name.toLowerCase().endsWith(suffix))) return false
  if (SENSITIVE_NAMES.has(name.toLowerCase())) return true
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(name))
}

/**
 * Pesan penolakan yang dikembalikan sebagai hasil tool, bukan exception, supaya
 * model membacanya dan melanjutkan dengan cara lain alih-alih mengulang.
 */
export function sensitiveRefusal(path: string): string {
  return `Ditolak: ${path} tampak memuat kredensial, dan isinya tidak boleh dikirim ke model. `
    + 'Lanjutkan tanpa membacanya. Bila perlu mengetahui nama variabelnya, '
    + 'baca berkas contoh seperti .env.example bila tersedia.'
}
