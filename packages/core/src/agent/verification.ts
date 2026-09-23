/**
 * Completion verification untuk pekerjaan coding.
 *
 * Model sering sudah menulis kesimpulan setelah edit terakhir, walau belum
 * menjalankan pemeriksaan apa pun. Modul ini mengenali perintah verifikasi dan
 * membuat pengingat yang disuntikkan hanya pada putaran model berikutnya. Ia
 * bukan bagian riwayat pengguna dan tidak disimpan ke sesi.
 */

import type { VerificationImpact } from '../tools/testImpact.ts'

export interface VerificationAttempt {
  command: string
  success: boolean
  /** Revisi mutasi yang diperiksa; dipakai agar edit baru membatalkan bukti lama. */
  revision?: number
  strength?: VerificationStrength
}

export type VerificationStrength = 'basic' | 'substantive'
export const CHANGE_RISK_VERIFICATION_MARK = '[CHANGE RISK VERIFICATION]'

/** Formatter, syntax-only check, dan whitespace check belum menguji perilaku. */
export function verificationStrength(command: string): VerificationStrength {
  return /(?:git\s+diff\s+--check|prettier\b|node\s+--check\b)/i.test(command) ? 'basic' : 'substantive'
}

export function hasSubstantiveVerification(attempts: readonly VerificationAttempt[], revision: number): boolean {
  return attempts.some((attempt) => attempt.success && attempt.revision === revision && (attempt.strength ?? verificationStrength(attempt.command)) === 'substantive')
}

export function riskVerificationPrompt(reasons: readonly string[]): string {
  return `${CHANGE_RISK_VERIFICATION_MARK}
Diff aktual dinilai berisiko tinggi${reasons.length ? `: ${reasons.join('; ')}` : ''}.
Bukti saat ini hanya pemeriksaan dasar. Jalankan verifikasi substantif yang paling relevan setelah edit terakhir—test terarah, typecheck, build, atau diagnostics proyek. Jangan hanya mengulang formatter, syntax-only check, atau git diff --check. Jika repository benar-benar tidak menyediakan pemeriksaan substantif, periksa diff dan jalur terdampak secara manual lalu nyatakan keterbatasannya dengan jujur.`
}

/**
 * Mengenali command yang memberi bukti tentang hasil perubahan. Pencocokan
 * sengaja berpusat pada executable/subcommand, bukan kata "test" di sembarang
 * tempat, agar `echo test` tidak dianggap verifikasi.
 */
export function isVerificationCommand(command: unknown): command is string {
  if (typeof command !== 'string') return false
  const text = command.trim()
  if (!text) return false

  return [
    /(?:^|[;&|]\s*)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|lint|typecheck|check|build)(?:\s|$)/i,
    /(?:^|[;&|]\s*)(?:(?:npx|npm\s+exec|pnpm\s+exec|yarn\s+exec|bunx)\s+)?(?:tsc|vue-tsc|eslint|biome|prettier|vitest|jest)\b/i,
    /(?:^|[;&|]\s*)(?:node\s+--test|node\s+--check)\b/i,
    /(?:^|[;&|]\s*)(?:pytest|python(?:3)?\s+-m\s+(?:pytest|unittest)|ruff|mypy|pyright)\b/i,
    /(?:^|[;&|]\s*)(?:go\s+(?:test|vet)|cargo\s+(?:test|check|clippy|build))\b/i,
    /(?:^|[;&|]\s*)(?:(?:dart|flutter)\s+(?:test|analyze)|gradle\w*\s+(?:test|check|build)|mvn\w*\s+(?:test|verify|package))\b/i,
    /(?:^|[;&|]\s*)(?:make\s+(?:test|check|lint|build)|git\s+diff\s+--check)\b/i,
  ].some((pattern) => pattern.test(text))
}

export function verificationPrompt(files: readonly string[], attempts: readonly VerificationAttempt[], impact?: VerificationImpact): string {
  const changed = files.length ? files.join(', ') : 'berkas dalam workspace'
  const last = attempts.at(-1)
  const evidence = last
    ? last.success
      ? `Pemeriksaan terakhir berhasil, tetapi ada edit yang lebih baru: ${last.command}`
      : `Pemeriksaan terakhir gagal: ${last.command}`
    : 'Belum ada pemeriksaan setelah perubahan terakhir.'

  const tests = impact ? [...impact.directTests, ...impact.dependentTests] : []
  const affected = impact?.affectedFiles.filter((file) => !file.test).slice(0, 12) ?? []
  const suggestions = [
    affected.length ? `Graph dampak ${impact!.blastRadius}: ${affected.map((file) => `${file.path} (depth ${file.depth})`).join(', ')}${impact!.affectedFiles.filter((file) => !file.test).length > affected.length ? ', …' : ''}.` : '',
    tests.length ? `Test terkait yang ditemukan: ${tests.join(', ')}.` : '',
    impact?.commands.length ? `Command test yang terdeteksi dari konfigurasi proyek: ${impact.commands.map((entry) => entry.command).join(' atau ')}.` : '',
  ].filter(Boolean).join('\n')

  return `[Completion verification]
Perubahan belum boleh dinyatakan selesai: ${changed}.
${evidence}
${suggestions ? `${suggestions}\n` : ''}Pilih pemeriksaan terkecil yang cukup kuat untuk jalur terdampak; rekomendasi di atas belum dijalankan dan tetap mengikuti approval/sandbox.
Jalankan pemeriksaan paling relevan yang tersedia (test, lint, typecheck, build, atau diagnostic khusus). Baca manifest/aturan proyek bila command belum diketahui. Jika proyek benar-benar tidak mempunyai pemeriksaan otomatis, jalankan pemeriksaan aman seperti git diff --check bila tersedia, periksa diff secara manual, lalu jelaskan keterbatasannya. Jika pemeriksaan gagal, diagnosis dan perbaiki; jangan menyembunyikan kegagalannya.`
}
