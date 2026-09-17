import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { updateEnvFile } from '../src/config.ts'

test('setelan baru ditulis ke folder yang dibuat, hanya untuk pemiliknya', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'boo-setelan-')), 'baru', '.env')
  updateEnvFile(path, { NINEROUTER_URL: 'http://localhost:20128', NINEROUTER_KEY: 'sk-rahasia' })
  assert.equal(readFileSync(path, 'utf8'), 'NINEROUTER_URL=http://localhost:20128\nNINEROUTER_KEY=sk-rahasia\n')
  assert.equal(statSync(path).mode & 0o777, 0o600)
})

test('kunci yang ada diganti di tempatnya; komentar dan kunci lain tetap', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'boo-setelan-')), '.env')
  writeFileSync(path, '# setelan saya\nBOO_EFFORT=high\nNINEROUTER_KEY=sk-lama\n# NINEROUTER_URL=http://contoh\n', { mode: 0o644 })
  updateEnvFile(path, { NINEROUTER_KEY: 'sk-baru', BOO_MODEL: 'cx/gpt-5.6-sol' })
  assert.equal(readFileSync(path, 'utf8'), '# setelan saya\nBOO_EFFORT=high\nNINEROUTER_KEY=sk-baru\n# NINEROUTER_URL=http://contoh\nBOO_MODEL=cx/gpt-5.6-sol\n')
  assert.equal(statSync(path).mode & 0o777, 0o600, 'berkas lama yang terbuka dikunci')
})
