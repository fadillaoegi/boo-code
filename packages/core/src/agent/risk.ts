/** Penilaian risiko deterministik dari diff checkpoint, tanpa panggilan model. */

import type { CheckpointFileChange } from './checkpoints.ts'
import { diffLines, diffStats } from '../tools/diff.ts'

export type ChangeRiskLevel = 'low' | 'medium' | 'high'

export interface ChangeRiskAssessment {
  level: ChangeRiskLevel
  score: number
  reasons: string[]
  changedFiles: number
  changedLines: number
}

const MAX_SCANNED_CHARACTERS = 256_000

function asText(content: Buffer | null): string | null {
  if (!content || content.includes(0)) return content ? null : ''
  return content.toString('utf8').slice(0, MAX_SCANNED_CHARACTERS)
}

/** Alasan tidak pernah memuat source/path lengkap agar aman ditampilkan dan ditrace. */
export function assessChangeRisk(changes: readonly CheckpointFileChange[]): ChangeRiskAssessment {
  const signals = new Map<string, { points: number; reason: string }>()
  let changedLines = 0
  const add = (id: string, points: number, reason: string) => {
    if (!signals.has(id)) signals.set(id, { points, reason })
  }

  for (const change of changes) {
    const path = change.label.toLowerCase()
    const before = asText(change.before)
    const after = asText(change.after)
    if (before === null || after === null) {
      changedLines += 1
      add('binary', 2, 'berkas biner berubah')
    } else {
      const lines = diffLines(before, after)
      const stats = diffStats(lines)
      changedLines += stats.added + stats.removed
      const added = lines.filter((line) => line.kind === 'add').map((line) => line.text).join('\n')
      if (/(?:rejectUnauthorized\s*:\s*false|verify\w*\s*[:=]\s*false|chmod\s+777|dangerouslyDisable|Access-Control-Allow-Origin.{0,20}\*)/i.test(added)) {
        add('bypass', 6, 'pola pelemahan kontrol keamanan ditambahkan')
      }
      if (change.before && !change.after) add('delete', 3, 'berkas yang sudah ada dihapus')
    }

    if (/(?:^|\/)(?:auth|authentication|authorization|security|permission|permissions|acl|rbac|session|token|oauth|crypto)(?:[._/-]|$)/i.test(path)) {
      add('security-boundary', 5, 'batas autentikasi/otorisasi atau keamanan berubah')
    }
    if (/(?:payment|billing|invoice|checkout|wallet|ledger|transaction)/i.test(path)) {
      add('financial', 5, 'alur pembayaran atau transaksi berubah')
    }
    if (/(?:migration|migrations|schema|database|db\/|\.sql$)/i.test(path)) {
      add('data-model', 4, 'schema, migrasi, atau penyimpanan data berubah')
    }
    if (/(?:^|\/)(?:\.github\/workflows|deploy|deployment|infra|terraform|k8s|docker)(?:[._/-]|$)/i.test(path)) {
      add('delivery', 4, 'konfigurasi deployment/infrastruktur berubah')
    }
    if (/(?:^|\/)(?:package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|go\.mod|cargo\.toml|pyproject\.toml)$/i.test(path)) {
      add('dependencies', 2, 'dependency atau manifest build berubah')
    }
  }

  if (changes.length >= 8) add('many-files', 3, `cakupan perubahan besar (${changes.length} berkas)`)
  if (changedLines >= 1_000) add('very-large-diff', 5, `diff sangat besar (${changedLines} baris)`)
  else if (changedLines >= 300) add('large-diff', 3, `diff besar (${changedLines} baris)`)

  const score = [...signals.values()].reduce((total, signal) => total + signal.points, 0)
  return {
    level: score >= 4 ? 'high' : score >= 2 ? 'medium' : 'low',
    score,
    reasons: [...signals.values()].sort((a, b) => b.points - a.points).slice(0, 4).map((signal) => signal.reason),
    changedFiles: changes.length,
    changedLines,
  }
}
