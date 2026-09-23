/** Pembelajaran kemampuan provider/model dari sinyal runtime; tanpa prompt atau source. */

import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ProviderError } from './errors.ts'

export const PROVIDER_CAPABILITY_SCHEMA_VERSION = 1
export const PROVIDER_CAPABILITY_PATH = '.boo/provider-capabilities.json'
export const PROVIDER_CAPABILITY_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1_000
export const PROVIDER_AVAILABILITY_COOLDOWN_MS = 6 * 60 * 60 * 1_000
const MAX_PROFILE_BYTES = 512 * 1024
const MAX_MODELS = 500
const MAX_OBSERVATIONS = 200

export type ProviderCapability = 'availability' | 'tools' | 'vision' | 'reasoning'

export interface CapabilityEvidence {
  successes: number
  failures: number
  unsupported: number
  updatedAt: number
}

export interface ProviderCapabilityStat {
  model: string
  availability: CapabilityEvidence
  tools: CapabilityEvidence
  vision: CapabilityEvidence
  reasoning: CapabilityEvidence
  maxContextTokens: number
  minContextFailureTokens?: number
  contextUpdatedAt: number
  updatedAt: number
}

export interface ProviderCapabilityProfile {
  schemaVersion: 1
  updatedAt: number
  models: ProviderCapabilityStat[]
}

export interface ProviderRequirements {
  vision?: boolean
  tools?: boolean
  contextTokens?: number
  reasoning?: boolean
}

export type ProviderCapabilityObservation =
  | { kind: 'response'; model: string; tools?: boolean; vision?: boolean; reasoning?: boolean; contextTokens?: number }
  | { kind: 'unsupported'; model: string; capability: Exclude<ProviderCapability, 'availability'> }
  | { kind: 'unavailable'; model: string }
  | { kind: 'tool-protocol-failure'; model: string }
  | { kind: 'context-limit'; model: string; contextTokens?: number }

export interface CapabilitySelection {
  ids: string[]
  avoided: number
  samples: number
  reasons: string[]
}

function finiteInteger(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
}

function parseEvidence(value: unknown): CapabilityEvidence | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const item = value as Record<string, unknown>
  if (![item.successes, item.failures, item.unsupported, item.updatedAt].every((entry) => finiteInteger(entry))) return null
  if ((item.successes as number) > MAX_OBSERVATIONS || (item.failures as number) > MAX_OBSERVATIONS || (item.unsupported as number) > MAX_OBSERVATIONS) return null
  return item as unknown as CapabilityEvidence
}

function parseStat(value: unknown): ProviderCapabilityStat | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const item = value as Record<string, unknown>
  if (typeof item.model !== 'string' || !item.model || item.model.length > 300) return null
  const availability = parseEvidence(item.availability)
  const tools = parseEvidence(item.tools)
  const vision = parseEvidence(item.vision)
  const reasoning = parseEvidence(item.reasoning)
  if (!availability || !tools || !vision || !reasoning) return null
  if (!finiteInteger(item.maxContextTokens) || !finiteInteger(item.contextUpdatedAt) || !finiteInteger(item.updatedAt)) return null
  if (item.minContextFailureTokens !== undefined && !finiteInteger(item.minContextFailureTokens, 1)) return null
  return {
    model: item.model,
    availability,
    tools,
    vision,
    reasoning,
    maxContextTokens: item.maxContextTokens,
    ...(item.minContextFailureTokens === undefined ? {} : { minContextFailureTokens: item.minContextFailureTokens as number }),
    contextUpdatedAt: item.contextUpdatedAt,
    updatedAt: item.updatedAt,
  }
}

export function parseProviderCapabilityProfile(value: unknown): ProviderCapabilityProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Profil capability harus berupa object.')
  const input = value as Record<string, unknown>
  if (input.schemaVersion !== PROVIDER_CAPABILITY_SCHEMA_VERSION) throw new Error(`Versi profil capability tidak didukung: ${String(input.schemaVersion)}.`)
  if (!finiteInteger(input.updatedAt) || !Array.isArray(input.models) || input.models.length > MAX_MODELS) throw new Error('Profil capability tidak valid.')
  const models = input.models.map(parseStat)
  if (models.some((item) => item === null)) throw new Error('Profil capability memuat statistik tidak valid.')
  const unique = new Set((models as ProviderCapabilityStat[]).map((item) => item.model))
  if (unique.size !== models.length) throw new Error('Profil capability memuat model duplikat.')
  return { schemaVersion: 1, updatedAt: input.updatedAt, models: models as ProviderCapabilityStat[] }
}

export function providerCapabilityFile(home: string): string {
  return join(home, PROVIDER_CAPABILITY_PATH)
}

export function loadProviderCapabilityProfile(home: string): ProviderCapabilityProfile | null {
  const path = providerCapabilityFile(home)
  try {
    if (lstatSync(path).isSymbolicLink() || statSync(path).size > MAX_PROFILE_BYTES) return null
    return parseProviderCapabilityProfile(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return null
  }
}

export function saveProviderCapabilityProfile(home: string, profile: ProviderCapabilityProfile): string {
  const path = providerCapabilityFile(home)
  const directory = join(home, '.boo')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  chmodSync(directory, 0o700)
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, path)
  chmodSync(path, 0o600)
  return path
}

function emptyEvidence(now: number): CapabilityEvidence {
  return { successes: 0, failures: 0, unsupported: 0, updatedAt: now }
}

function emptyStat(model: string, now: number): ProviderCapabilityStat {
  return {
    model,
    availability: emptyEvidence(now),
    tools: emptyEvidence(now),
    vision: emptyEvidence(now),
    reasoning: emptyEvidence(now),
    maxContextTokens: 0,
    contextUpdatedAt: now,
    updatedAt: now,
  }
}

function increment(evidence: CapabilityEvidence, field: 'successes' | 'failures' | 'unsupported', now: number): void {
  if (evidence.successes >= MAX_OBSERVATIONS || evidence.failures >= MAX_OBSERVATIONS || evidence.unsupported >= MAX_OBSERVATIONS) {
    evidence.successes = Math.floor(evidence.successes / 2)
    evidence.failures = Math.floor(evidence.failures / 2)
    evidence.unsupported = Math.floor(evidence.unsupported / 2)
  }
  evidence[field] += 1
  evidence.updatedAt = now
}

/** Satu observasi hanya berisi angka/kategori/model; tidak menerima teks task atau output. */
export function updateProviderCapabilityProfile(
  previous: ProviderCapabilityProfile | null,
  observation: ProviderCapabilityObservation,
  now = Date.now(),
): ProviderCapabilityProfile {
  const profile: ProviderCapabilityProfile = previous
    ? { ...previous, models: previous.models.map((item) => ({
      ...item,
      availability: { ...item.availability }, tools: { ...item.tools }, vision: { ...item.vision }, reasoning: { ...item.reasoning },
    })) }
    : { schemaVersion: 1, updatedAt: now, models: [] }
  let stat = profile.models.find((item) => item.model === observation.model)
  if (!stat) {
    stat = emptyStat(observation.model, now)
    profile.models.push(stat)
  }

  if (observation.kind === 'response') {
    stat.availability.unsupported = 0
    increment(stat.availability, 'successes', now)
    if (observation.tools) {
      stat.tools.unsupported = 0
      increment(stat.tools, 'successes', now)
    }
    if (observation.vision) {
      stat.vision.unsupported = 0
      increment(stat.vision, 'successes', now)
    }
    if (observation.reasoning) {
      stat.reasoning.unsupported = 0
      increment(stat.reasoning, 'successes', now)
    }
    if (finiteInteger(observation.contextTokens, 1)) {
      stat.maxContextTokens = Math.max(stat.maxContextTokens, observation.contextTokens)
      stat.contextUpdatedAt = now
    }
  } else if (observation.kind === 'unsupported') {
    increment(stat[observation.capability], 'failures', now)
    increment(stat[observation.capability], 'unsupported', now)
  } else if (observation.kind === 'unavailable') {
    increment(stat.availability, 'failures', now)
    increment(stat.availability, 'unsupported', now)
  } else if (observation.kind === 'tool-protocol-failure') {
    increment(stat.tools, 'failures', now)
  } else {
    increment(stat.availability, 'failures', now)
    if (finiteInteger(observation.contextTokens, 1)) {
      stat.minContextFailureTokens = stat.minContextFailureTokens === undefined
        ? observation.contextTokens
        : Math.min(stat.minContextFailureTokens, observation.contextTokens)
    }
    stat.contextUpdatedAt = now
  }
  stat.updatedAt = now
  profile.updatedAt = now
  if (profile.models.length > MAX_MODELS) {
    profile.models.sort((left, right) => right.updatedAt - left.updatedAt)
    profile.models = profile.models.slice(0, MAX_MODELS)
  }
  profile.models.sort((left, right) => left.model.localeCompare(right.model))
  return profile
}

function latestUnsupported(evidence: CapabilityEvidence, now: number, maxAge = PROVIDER_CAPABILITY_MAX_AGE_MS): boolean {
  return evidence.unsupported > 0 && now - evidence.updatedAt <= maxAge
}

/** Menyaring hanya ketidakmampuan eksplisit dan segar; model unknown tetap boleh dieksplorasi. */
export function selectByCapabilities(
  ids: readonly string[],
  requirements: ProviderRequirements,
  profile: ProviderCapabilityProfile | null,
  now = Date.now(),
): CapabilitySelection {
  if (!profile) return { ids: [...ids], avoided: 0, samples: 0, reasons: [] }
  let samples = 0
  const reasons = new Set<string>()
  const selected = ids.filter((id) => {
    const stat = profile.models.find((item) => item.model === id)
    if (!stat || now - stat.updatedAt > PROVIDER_CAPABILITY_MAX_AGE_MS) return true
    samples += stat.availability.successes + stat.availability.failures
      + stat.tools.successes + stat.tools.failures + stat.vision.successes + stat.vision.failures
    if (latestUnsupported(stat.availability, now, PROVIDER_AVAILABILITY_COOLDOWN_MS)) {
      reasons.add('route tidak tersedia')
      return false
    }
    if (requirements.vision && latestUnsupported(stat.vision, now)) {
      reasons.add('input gambar tidak didukung')
      return false
    }
    if (requirements.tools && latestUnsupported(stat.tools, now)) {
      reasons.add('tool calling tidak didukung')
      return false
    }
    if (requirements.reasoning && latestUnsupported(stat.reasoning, now)) {
      reasons.add('reasoning effort tidak didukung')
      return false
    }
    if (requirements.contextTokens && stat.minContextFailureTokens !== undefined
      && requirements.contextTokens >= stat.minContextFailureTokens
      && stat.maxContextTokens < requirements.contextTokens
      && now - stat.contextUpdatedAt <= PROVIDER_CAPABILITY_MAX_AGE_MS) {
      reasons.add('konteks terlalu kecil')
      return false
    }
    return true
  })
  // Profil lama/tidak lengkap tidak boleh membuat Auto kehilangan semua model.
  return selected.length
    ? { ids: selected, avoided: ids.length - selected.length, samples, reasons: [...reasons] }
    : { ids: [...ids], avoided: 0, samples, reasons: [] }
}

export type ProviderCapabilityFailure = 'unavailable' | 'vision-unsupported' | 'tools-unsupported' | 'reasoning-unsupported' | 'context-limit'

export function classifyProviderCapabilityError(error: ProviderError, hasImages: boolean): ProviderCapabilityFailure | null {
  const message = error.message
  if (error.status === 404) return 'unavailable'
  if (error.status !== 400 && error.status !== 413) return null
  if (hasImages && /(?:image|vision|multimodal|image_url)/i.test(message)) return 'vision-unsupported'
  if (/(?:tool(?:s|_calls?| calling)?|function(?:s|_calls?| calling)?).{0,40}(?:unsupported|not support|invalid|unavailable)|(?:unsupported|not support).{0,40}(?:tool|function)/i.test(message)) return 'tools-unsupported'
  if (/(?:reasoning|thinking|reasoning_effort).{0,40}(?:unsupported|not support|invalid)|(?:unsupported|not support).{0,40}(?:reasoning|thinking)/i.test(message)) return 'reasoning-unsupported'
  if (/context.{0,30}(?:length|window|limit)|maximum context|too many tokens|input.{0,20}too (?:long|large)/i.test(message)) return 'context-limit'
  return null
}

export function formatProviderCapabilityProfile(profile: ProviderCapabilityProfile | null, now = Date.now()): string {
  if (!profile?.models.length) return 'Belum ada observasi capability model lokal.'
  const lines = profile.models
    .filter((item) => now - item.updatedAt <= PROVIDER_CAPABILITY_MAX_AGE_MS)
    .map((item) => {
      const values = [
        `response ${item.availability.successes}/${item.availability.failures}`,
        `tools ${item.tools.successes}/${item.tools.failures}`,
        `vision ${item.vision.successes}/${item.vision.failures}`,
        `reasoning ${item.reasoning.successes}/${item.reasoning.failures}`,
        item.maxContextTokens ? `context ≥${item.maxContextTokens.toLocaleString('id-ID')}` : '',
        item.minContextFailureTokens ? `gagal ≥${item.minContextFailureTokens.toLocaleString('id-ID')}` : '',
      ].filter(Boolean)
      return `${item.model} · ${values.join(' · ')}`
    })
  return lines.length ? `Capability model lokal (${lines.length}):\n${lines.join('\n')}` : 'Belum ada observasi capability model yang masih segar.'
}
