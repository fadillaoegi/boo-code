import assert from 'node:assert/strict'
import test from 'node:test'
import { assessChangeRisk } from '../src/agent/risk.ts'
import { hasSubstantiveVerification, verificationStrength } from '../src/agent/verification.ts'

const change = (label: string, before: string | null, after: string | null) => ({
  label,
  before: before === null ? null : Buffer.from(before),
  after: after === null ? null : Buffer.from(after),
})

test('risk engine membedakan perubahan biasa, manifest, dan security boundary', () => {
  const low = assessChangeRisk([change('src/format.ts', 'export const n = 1\n', 'export const n = 2\n')])
  assert.equal(low.level, 'low')
  assert.equal(low.changedLines, 2)

  const medium = assessChangeRisk([change('package.json', '{"a":1}\n', '{"a":2}\n')])
  assert.equal(medium.level, 'medium')
  assert.match(medium.reasons.join(' '), /dependency/)

  const high = assessChangeRisk([change('src/auth/session.ts', 'export const allowed = false\n', 'export const allowed = true\n')])
  assert.equal(high.level, 'high')
  assert.match(high.reasons.join(' '), /autentikasi/)
})

test('pola bypass keamanan dan cakupan diff menaikkan risiko tanpa membocorkan source', () => {
  const result = assessChangeRisk([
    change('src/client.ts', '', 'const agent = new Agent({ rejectUnauthorized: false })\n'),
    ...Array.from({ length: 8 }, (_, index) => change(`src/file-${index}.ts`, '', `export const n${index} = ${index}\n`)),
  ])
  assert.equal(result.level, 'high')
  assert.ok(result.score >= 6)
  assert.match(result.reasons.join(' '), /pelemahan kontrol keamanan/)
  assert.doesNotMatch(JSON.stringify(result), /rejectUnauthorized|src\/client/)
})

test('verifikasi substantif dibedakan dari formatter dan syntax-only check', () => {
  assert.equal(verificationStrength('git diff --check'), 'basic')
  assert.equal(verificationStrength('prettier --check .'), 'basic')
  assert.equal(verificationStrength('node --check app.js'), 'basic')
  assert.equal(verificationStrength('pnpm test'), 'substantive')
  assert.equal(verificationStrength('diagnostics'), 'substantive')
  assert.equal(hasSubstantiveVerification([{ command: 'git diff --check', success: true, revision: 2, strength: 'basic' }], 2), false)
  assert.equal(hasSubstantiveVerification([{ command: 'pnpm test', success: true, revision: 2, strength: 'substantive' }], 2), true)
})
