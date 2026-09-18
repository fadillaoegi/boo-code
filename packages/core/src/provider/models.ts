/**
 * Mengelompokkan model 9Router menjadi keluarga dan tingkat penalaran.
 *
 * 9Router mendaftarkan setiap kombinasi sebagai model terpisah, sehingga daftar
 * mentahnya panjang dan berulang. Pengguna sebenarnya memilih dua hal: model apa,
 * lalu seberapa keras ia berpikir.
 *
 * Tingkat penalaran disampaikan lewat dua mekanisme yang berbeda:
 * - `model-id`  — tertanam di nama model, misalnya `ag/gemini-3.7-flash-high`.
 *                 Memilih tingkat berarti memilih model yang lain.
 * - `parameter` — nama model tetap, tingkatnya dikirim sebagai `reasoning_effort`.
 *                 Ini cara kerja Codex.
 *
 * Pengelompokan selalu diturunkan dari daftar model yang benar-benar tersedia,
 * sehingga pemilih tidak pernah menawarkan tingkat yang tidak ada — misalnya
 * Gemini 3.5 Flash memang tidak punya varian medium.
 */

export type EffortSource = 'model-id' | 'parameter'

export interface EffortOption {
  /** Nilai mentah: `extra-low`, `low`, `medium`, `high`, atau `xhigh`. */
  level: string
  label: string
  /** Model yang dikirim ke 9Router. */
  modelId: string
  /** Diisi hanya untuk sumber `parameter`; dikirim sebagai `reasoning_effort`. */
  reasoningEffort?: string
}

export interface ModelFamily {
  /** Kunci stabil untuk keluarga, misalnya `ag/gemini-3.7-flash`. */
  key: string
  label: string
  source: EffortSource | null
  /** Terurut dari tingkat terendah; berisi satu entri bila tidak ada pilihan. */
  options: EffortOption[]
}

/**
 * Model Codex yang sudah diverifikasi menerima `reasoning_effort` lewat 9Router.
 *
 * Diverifikasi dengan dua cara: nilai tak valid ditolak upstream dengan
 * "Invalid value" (bukti parameter sampai), dan low, medium, high, serta xhigh
 * diterima. Model Codex lain belum diverifikasi, jadi sengaja tidak dimasukkan —
 * menawarkan tingkat yang tidak didukung akan gagal saat dikirim.
 */
const PARAMETER_EFFORT_LEVELS: Record<string, string[]> = {
  'cx/gpt-5.6-sol': ['low', 'medium', 'high', 'xhigh'],
  'cx/gpt-5.6-terra': ['low', 'medium', 'high', 'xhigh'],
  'cx/gpt-5.6-luna': ['low', 'medium', 'high', 'xhigh'],
}

const EFFORT_ORDER = ['extra-low', 'low', 'medium', 'high', 'xhigh']

const EFFORT_LABEL: Record<string, string> = {
  'extra-low': 'Extra Low',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
}

/** `ag/gemini-3.7-flash-high` → keluarga `ag/gemini-3.7-flash`, tingkat `high`. */
const MODEL_ID_EFFORT = /^(ag\/gemini-(\d+(?:\.\d+)?)-(flash|pro))-(extra-low|low|medium|high)$/

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1)
}

/** Nama yang mudah dibaca untuk model tanpa aturan khusus. */
export function humanizeModel(id: string): string {
  const name = id.split('/').at(-1) ?? id
  return name
    .split('-')
    .map((part) => (/^gpt$/i.test(part) ? 'GPT' : /^oss$/i.test(part) ? 'OSS' : capitalize(part)))
    .join(' ')
    .replace(/^GPT (\d|OSS)/, 'GPT-$1')
    .replace(/(\d) (\d)/g, '$1.$2')
}

export function effortLabel(level: string): string {
  return EFFORT_LABEL[level] ?? capitalize(level)
}

function byEffort(a: EffortOption, b: EffortOption): number {
  return EFFORT_ORDER.indexOf(a.level) - EFFORT_ORDER.indexOf(b.level)
}

/**
 * Menyusun keluarga dari daftar id model yang tersedia.
 * Urutan keluarga mengikuti kemunculan pertamanya di daftar.
 */
export function groupModels(ids: string[]): ModelFamily[] {
  const families = new Map<string, ModelFamily>()

  for (const id of ids) {
    const encoded = MODEL_ID_EFFORT.exec(id)
    if (encoded) {
      const [, key, version, tier, level] = encoded
      const family = families.get(key) ?? {
        key,
        label: `Gemini ${version} ${capitalize(tier)}`,
        source: 'model-id' as const,
        options: [],
      }
      family.options.push({ level, label: effortLabel(level), modelId: id })
      families.set(key, family)
      continue
    }

    const levels = PARAMETER_EFFORT_LEVELS[id]
    if (levels) {
      families.set(id, {
        key: id,
        label: humanizeModel(id),
        source: 'parameter',
        options: levels.map((level) => ({
          level,
          label: effortLabel(level),
          modelId: id,
          reasoningEffort: level,
        })),
      })
      continue
    }

    families.set(id, {
      key: id,
      label: humanizeModel(id),
      source: null,
      options: [{ level: '', label: '', modelId: id }],
    })
  }

  for (const family of families.values()) {
    if (family.source === 'model-id') family.options.sort(byEffort)
    // Satu varian saja bukan pilihan; perlakukan seperti model biasa.
    if (family.options.length === 1) family.source = null
  }
  return [...families.values()]
}

/** Mencari keluarga dan opsi yang sedang dipakai, bila ada. */
export function findSelection(
  families: ModelFamily[],
  modelId: string,
  reasoningEffort?: string,
): { family: ModelFamily; option: EffortOption } | null {
  for (const family of families) {
    const option = family.options.find((candidate) => candidate.modelId === modelId
      && (family.source !== 'parameter' || candidate.reasoningEffort === reasoningEffort))
    if (option) return { family, option }
  }
  return null
}

/** Label singkat untuk ditampilkan, misalnya "GPT-5.6 Sol · Extra High". */
export function describeSelection(families: ModelFamily[], modelId: string, reasoningEffort?: string): string {
  const found = findSelection(families, modelId, reasoningEffort)
  if (!found) {
    // Model dikenal tetapi tanpa tingkat yang cocok — misalnya GPT-5.6 Sol yang
    // dipakai tanpa reasoning_effort. Nama keluarganya tetap lebih terbaca.
    const family = families.find((item) => item.options.some((option) => option.modelId === modelId))
    const name = family?.label ?? modelId
    return reasoningEffort ? `${name} · ${effortLabel(reasoningEffort)}` : name
  }
  // Label tingkat ditampilkan setiap kali ada, termasuk untuk keluarga satu varian
  // seperti ag/gemini-3.7-flash-high yang dipilih langsung lewat /model <id>.
  const { family, option } = found
  return option.label ? `${family.label} · ${option.label}` : family.label
}

/** Keluarga model yang ditampilkan lebih dulu di pemilih model CLI dan web. */
export const FEATURED_FAMILIES = [
  'ag/gemini-3.5-flash',
  'ag/gemini-3.7-flash',
  'ag/gemini-3.1-pro',
  'ag/claude-sonnet-4-6',
  'ag/claude-opus-4-6-thinking',
  'cx/gpt-5.6-luna',
  'cx/gpt-5.6-terra',
  'cx/gpt-5.6-sol',
]

/** Tingkat penalaran yang benar-benar diterima model ini, atau undefined. */
export function acceptedEffort(model: string, effort: string | undefined): string | undefined {
  if (!effort) return undefined
  const [family] = groupModels([model])
  if (family?.source !== 'parameter') return undefined
  return family.options.some((option) => option.reasoningEffort === effort) ? effort : undefined
}
