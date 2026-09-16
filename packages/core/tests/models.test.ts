import assert from 'node:assert/strict'
import test from 'node:test'
import { describeSelection, findSelection, groupModels, humanizeModel } from '../src/provider/models.ts'

/** Daftar model yang benar-benar dikembalikan 9Router milik pengguna. */
const LIVE_MODELS = [
  'ag/gemini-3.7-flash-high',
  'ag/gemini-3.7-flash-medium',
  'ag/gemini-3.7-flash-low',
  'ag/gemini-3.6-flash-high',
  'ag/gemini-3.6-flash-medium',
  'ag/gemini-3.6-flash-low',
  'ag/gemini-3.5-flash-high',
  'ag/gemini-3-flash-agent',
  'ag/gemini-3.5-flash-low',
  'ag/gemini-3.5-flash-extra-low',
  'ag/gemini-pro-agent',
  'ag/gemini-3.1-pro-low',
  'ag/claude-sonnet-4-6',
  'ag/claude-opus-4-6-thinking',
  'ag/gpt-oss-120b-medium',
  'ag/gemini-3-flash',
  'cx/gpt-5.6-sol',
  'cx/gpt-5.6-terra',
  'cx/gpt-5.6-luna',
  'cx/gpt-5.5',
  'cx/gpt-5.4',
  'cx/gpt-5.4-mini',
  'cx/gpt-5.3-codex-spark',
]

function family(key: string) {
  const found = groupModels(LIVE_MODELS).find((item) => item.key === key)
  assert.ok(found, `keluarga ${key} seharusnya ada`)
  return found
}

test('varian gemini dengan tingkat di nama model digabung menjadi satu keluarga', () => {
  const gemini37 = family('ag/gemini-3.7-flash')
  assert.equal(gemini37.label, 'Gemini 3.7 Flash')
  assert.equal(gemini37.source, 'model-id')
  assert.deepEqual(gemini37.options.map((o) => o.level), ['low', 'medium', 'high'])
  assert.equal(gemini37.options[2].modelId, 'ag/gemini-3.7-flash-high')
})

test('tingkat yang tidak ada tidak pernah ditawarkan', () => {
  // Gemini 3.5 Flash memang tidak punya medium, tetapi punya extra-low.
  const gemini35 = family('ag/gemini-3.5-flash')
  assert.deepEqual(gemini35.options.map((o) => o.label), ['Extra Low', 'Low', 'High'])
})

test('keluarga dengan satu varian bukan pilihan tingkat', () => {
  const pro = family('ag/gemini-3.1-pro')
  assert.equal(pro.options.length, 1)
  assert.equal(pro.source, null)
})

test('model codex terverifikasi memakai parameter, bukan model berbeda', () => {
  const sol = family('cx/gpt-5.6-sol')
  assert.equal(sol.label, 'GPT-5.6 Sol')
  assert.equal(sol.source, 'parameter')
  assert.deepEqual(sol.options.map((o) => o.label), ['Low', 'Medium', 'High', 'Extra High'])
  // Semua opsi memakai model yang sama; hanya reasoning_effort yang berbeda.
  assert.ok(sol.options.every((o) => o.modelId === 'cx/gpt-5.6-sol'))
  assert.equal(sol.options[3].reasoningEffort, 'xhigh')
})

test('model codex yang belum diverifikasi tidak diberi pilihan tingkat', () => {
  const gpt55 = family('cx/gpt-5.5')
  assert.equal(gpt55.source, null)
  assert.equal(gpt55.options[0].reasoningEffort, undefined)
})

test('model tanpa aturan khusus tetap tersedia apa adanya', () => {
  const claude = family('ag/claude-sonnet-4-6')
  assert.equal(claude.source, null)
  assert.equal(claude.options[0].modelId, 'ag/claude-sonnet-4-6')
})

test('daftar keluarga jauh lebih pendek dari daftar mentah', () => {
  const families = groupModels(LIVE_MODELS)
  assert.ok(families.length < LIVE_MODELS.length)
  const allIds = families.flatMap((f) => f.options.map((o) => o.modelId))
  for (const id of LIVE_MODELS) assert.ok(allIds.includes(id), `${id} tidak boleh hilang`)
})

test('pilihan aktif ditemukan kembali, termasuk tingkat parameter', () => {
  const families = groupModels(LIVE_MODELS)
  assert.equal(findSelection(families, 'cx/gpt-5.6-terra', 'high')?.option.label, 'High')
  assert.equal(describeSelection(families, 'cx/gpt-5.6-luna', 'xhigh'), 'GPT-5.6 Luna · Extra High')
  assert.equal(describeSelection(families, 'ag/gemini-3.7-flash-low'), 'Gemini 3.7 Flash · Low')
  assert.equal(describeSelection(families, 'ag/claude-sonnet-4-6'), 'Claude Sonnet 4.6')
  // Dipilih langsung tanpa daftar lengkap: tingkatnya tetap harus terlihat.
  assert.equal(describeSelection(groupModels(['ag/gemini-3.7-flash-high']), 'ag/gemini-3.7-flash-high'), 'Gemini 3.7 Flash · High')
})

test('nama model dirapikan agar mudah dibaca', () => {
  assert.equal(humanizeModel('ag/claude-sonnet-4-6'), 'Claude Sonnet 4.6')
  assert.equal(humanizeModel('cx/gpt-5.5'), 'GPT-5.5')
  assert.equal(humanizeModel('ag/gpt-oss-120b-medium'), 'GPT-OSS 120b Medium')
})
