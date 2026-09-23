import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  classifyProviderCapabilityError,
  formatProviderCapabilityProfile,
  loadProviderCapabilityProfile,
  parseProviderCapabilityProfile,
  providerCapabilityFile,
  PROVIDER_AVAILABILITY_COOLDOWN_MS,
  saveProviderCapabilityProfile,
  selectByCapabilities,
  updateProviderCapabilityProfile,
  type ProviderCapabilityProfile,
} from '../src/provider/capabilities.ts'
import { ProviderError } from '../src/provider/errors.ts'

function learned(now = 100_000): ProviderCapabilityProfile {
  let profile = updateProviderCapabilityProfile(null, { kind: 'unavailable', model: 'model-offline' }, now)
  profile = updateProviderCapabilityProfile(profile, { kind: 'unsupported', model: 'model-text', capability: 'vision' }, now)
  profile = updateProviderCapabilityProfile(profile, { kind: 'unsupported', model: 'model-no-tools', capability: 'tools' }, now)
  profile = updateProviderCapabilityProfile(profile, { kind: 'context-limit', model: 'model-small', contextTokens: 8_000 }, now)
  return updateProviderCapabilityProfile(profile, {
    kind: 'response', model: 'model-good', tools: true, vision: true, reasoning: true, contextTokens: 20_000,
  }, now)
}

test('profil capability disimpan privat tanpa prompt, source, atau output', () => {
  const home = mkdtempSync(join(tmpdir(), 'boo-capability-home-'))
  const profile = learned()
  const path = saveProviderCapabilityProfile(home, profile)
  assert.equal(path, providerCapabilityFile(home))
  assert.deepEqual(loadProviderCapabilityProfile(home), profile)
  assert.equal(statSync(path).mode & 0o777, 0o600)
  assert.equal(statSync(join(home, '.boo')).mode & 0o777, 0o700)
  assert.doesNotMatch(readFileSync(path, 'utf8'), /prompt|source|output|answer/i)
})

test('selector menghindari ketidakmampuan eksplisit tetapi tetap mengeksplorasi model unknown', () => {
  const now = 100_000
  const ids = ['model-offline', 'model-text', 'model-no-tools', 'model-small', 'model-good', 'model-unknown']
  const selected = selectByCapabilities(ids, { vision: true, tools: true, reasoning: true, contextTokens: 10_000 }, learned(now), now)
  assert.deepEqual(selected.ids, ['model-good', 'model-unknown'])
  assert.equal(selected.avoided, 4)
  assert.ok(selected.samples >= 5)
  assert.deepEqual(new Set(selected.reasons), new Set([
    'route tidak tersedia', 'input gambar tidak didukung', 'tool calling tidak didukung', 'konteks terlalu kecil',
  ]))
})

test('availability cooldown kedaluwarsa dan profil tidak pernah mengunci semua model', () => {
  const now = 100_000
  const profile = updateProviderCapabilityProfile(null, { kind: 'unavailable', model: 'only' }, now)
  assert.deepEqual(selectByCapabilities(['only'], {}, profile, now).ids, ['only'])
  const later = now + PROVIDER_AVAILABILITY_COOLDOWN_MS + 1
  assert.deepEqual(selectByCapabilities(['only', 'unknown'], {}, profile, later).ids, ['only', 'unknown'])
})

test('respons sukses membersihkan unsupported lama untuk capability yang terbukti pulih', () => {
  const now = 100_000
  let profile = updateProviderCapabilityProfile(null, { kind: 'unsupported', model: 'recovered', capability: 'vision' }, now)
  profile = updateProviderCapabilityProfile(profile, { kind: 'response', model: 'recovered', vision: true }, now + 1)
  assert.deepEqual(selectByCapabilities(['recovered', 'other'], { vision: true }, profile, now + 1).ids, ['recovered', 'other'])
  assert.equal(profile.models[0].vision.failures, 1, 'riwayat reliability tetap dipertahankan')
  assert.equal(profile.models[0].vision.unsupported, 0)
})

test('parser menolak profil rusak dan model duplikat', () => {
  const profile = learned()
  assert.throws(() => parseProviderCapabilityProfile({ ...profile, schemaVersion: 9 }), /Versi/)
  assert.throws(() => parseProviderCapabilityProfile({ ...profile, models: [profile.models[0], profile.models[0]] }), /duplikat/)
  assert.equal(loadProviderCapabilityProfile('/path/yang/tidak/ada'), null)
})

test('error provider diklasifikasikan menjadi sinyal capability yang aman', () => {
  const error = (message: string, status: number) => new ProviderError(message, { status, retryable: false })
  assert.equal(classifyProviderCapabilityError(error('Requested entity was not found', 404), false), 'unavailable')
  assert.equal(classifyProviderCapabilityError(error('image_url is unsupported', 400), true), 'vision-unsupported')
  assert.equal(classifyProviderCapabilityError(error('tool calling is not supported', 400), false), 'tools-unsupported')
  assert.equal(classifyProviderCapabilityError(error('reasoning_effort unsupported', 400), false), 'reasoning-unsupported')
  assert.equal(classifyProviderCapabilityError(error('maximum context length exceeded', 400), false), 'context-limit')
  assert.equal(classifyProviderCapabilityError(error('bad request', 400), false), null)
})

test('formatter hanya menampilkan statistik agregat', () => {
  const text = formatProviderCapabilityProfile(learned(100_000), 100_000)
  assert.match(text, /Capability model lokal \(5\)/)
  assert.match(text, /model-good · response 1\/0/)
  assert.match(text, /context ≥20\.000/)
})
