/**
 * Penyedia model yang dikenal Boo.
 *
 * Boo lahir dengan satu pintu, 9Router, dan itu tetap jalur utamanya. Tetapi tidak
 * semua orang punya 9Router: sebagian hanya memegang kunci OpenAI atau Anthropic,
 * sebagian menjalankan model lokal lewat Ollama atau LM Studio. Di sini setiap
 * penyedia dijelaskan sekali — alamat bawaan, nama kunci di berkas setelan, dan
 * bentuk protokolnya — lalu dipakai bersama oleh gerbang model, wizard setup, dan
 * pemilih model.
 *
 * Model ditandai dengan awalan penyedia, misalnya `anthropic:claude-sonnet-4-6`.
 * Model tanpa awalan berarti penyedia utama, sehingga sesi dan setelan lama yang
 * menyimpan `ag/claude-sonnet-4-6` tetap berjalan apa adanya.
 *
 * Catatan yang disengaja: kredensial langganan Codex CLI dan Claude Code tidak
 * didukung. Keduanya diterbitkan untuk aplikasi itu sendiri, jadi yang dipakai di
 * sini hanya kunci API resmi atau 9Router.
 */

export type WireFormat = 'openai' | 'anthropic'

/** Penyedia yang sudah dikonfigurasi dan siap dipanggil. */
export interface ProviderProfile {
  id: string
  label: string
  baseUrl: string
  apiKey: string
  wire: WireFormat
}

export interface ProviderDefinition {
  id: string
  label: string
  /** Keterangan singkat untuk wizard setup. */
  hint: string
  defaultBaseUrl: string
  wire: WireFormat
  /** Nama kunci di ~/.boo/.env. */
  keyName: string
  urlName: string
  /** Penyedia lokal seperti Ollama tidak memerlukan kunci. */
  keyRequired: boolean
  /** Dari mana pengguna mendapatkan kuncinya. */
  keySource: string
}

export const PROVIDER_DEFINITIONS: readonly ProviderDefinition[] = [
  {
    id: 'ninerouter',
    label: '9Router',
    hint: 'satu pintu untuk semua model langgananmu',
    defaultBaseUrl: 'http://localhost:20128',
    wire: 'openai',
    keyName: 'NINEROUTER_KEY',
    urlName: 'NINEROUTER_URL',
    keyRequired: true,
    keySource: 'Dashboard 9Router',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    hint: 'API resmi OpenAI, dibayar per pemakaian',
    defaultBaseUrl: 'https://api.openai.com/v1',
    wire: 'openai',
    keyName: 'OPENAI_API_KEY',
    urlName: 'OPENAI_BASE_URL',
    keyRequired: true,
    keySource: 'platform.openai.com',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    hint: 'API resmi Claude, dibayar per pemakaian',
    defaultBaseUrl: 'https://api.anthropic.com',
    wire: 'anthropic',
    keyName: 'ANTHROPIC_API_KEY',
    urlName: 'ANTHROPIC_BASE_URL',
    keyRequired: true,
    keySource: 'console.anthropic.com',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    hint: 'banyak model dari satu kunci',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    wire: 'openai',
    keyName: 'OPENROUTER_API_KEY',
    urlName: 'OPENROUTER_BASE_URL',
    keyRequired: true,
    keySource: 'openrouter.ai/keys',
  },
  {
    id: 'ollama',
    label: 'Ollama',
    hint: 'model lokal di komputer ini, tanpa kunci',
    defaultBaseUrl: 'http://localhost:11434/v1',
    wire: 'openai',
    keyName: 'OLLAMA_API_KEY',
    urlName: 'OLLAMA_BASE_URL',
    keyRequired: false,
    keySource: 'tidak perlu kunci',
  },
  {
    id: 'custom',
    label: 'OpenAI-compatible lain',
    hint: 'LM Studio, vLLM, Groq, atau alamat sendiri',
    defaultBaseUrl: '',
    wire: 'openai',
    keyName: 'CUSTOM_API_KEY',
    urlName: 'CUSTOM_API_URL',
    keyRequired: false,
    keySource: 'penyedia yang bersangkutan',
  },
]

export const DEFAULT_PROVIDER_ID = 'ninerouter'
/** Pemisah awalan penyedia pada id model. */
export const MODEL_ID_SEPARATOR = ':'

export function providerDefinition(id: string): ProviderDefinition | undefined {
  return PROVIDER_DEFINITIONS.find((definition) => definition.id === id)
}

/**
 * Memisahkan awalan penyedia dari id model. Hanya awalan yang dikenal yang
 * dipotong, sehingga tag Ollama seperti `qwen2.5-coder:7b` tidak salah terbaca.
 */
export function splitModelId(id: string): { providerId: string | null; model: string } {
  const separator = id.indexOf(MODEL_ID_SEPARATOR)
  if (separator === -1) return { providerId: null, model: id }
  const prefix = id.slice(0, separator)
  if (!providerDefinition(prefix)) return { providerId: null, model: id }
  return { providerId: prefix, model: id.slice(separator + 1) }
}

/** Kebalikannya: id model milik penyedia utama tetap polos. */
export function qualifyModelId(providerId: string, model: string): string {
  if (providerId === DEFAULT_PROVIDER_ID) return model
  return `${providerId}${MODEL_ID_SEPARATOR}${model}`
}

/** Nama penyedia untuk ditampilkan, misalnya pada pemilih model. */
export function providerLabel(id: string | null): string {
  if (!id) return providerDefinition(DEFAULT_PROVIDER_ID)?.label ?? '9Router'
  return providerDefinition(id)?.label ?? id
}

export type ProviderSettings = Partial<Record<string, string | undefined>>

/**
 * Menyusun penyedia yang benar-benar dapat dipakai dari setelan. Penyedia utama —
 * yang melayani model tanpa awalan — adalah yang pertama dalam daftar.
 */
export function profilesFromConfig(config: ProviderSettings): ProviderProfile[] {
  const profiles: ProviderProfile[] = []
  for (const definition of PROVIDER_DEFINITIONS) {
    const apiKey = (config[definition.keyName] ?? '').trim()
    const baseUrl = (config[definition.urlName] ?? '').trim() || definition.defaultBaseUrl
    const usable = definition.keyRequired ? Boolean(apiKey) : Boolean((config[definition.urlName] ?? '').trim() || apiKey)
    if (!usable || !baseUrl) continue
    profiles.push({ id: definition.id, label: definition.label, baseUrl, apiKey, wire: definition.wire })
  }
  return profiles
}

/** Penyedia yang melayani model tanpa awalan. */
export function defaultProfile(profiles: readonly ProviderProfile[]): ProviderProfile | undefined {
  return profiles.find((profile) => profile.id === DEFAULT_PROVIDER_ID) ?? profiles[0]
}
