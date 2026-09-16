import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileTool } from '../src/tools/readFile.ts'
import { editFileTool } from '../src/tools/editFile.ts'
import { isSensitivePath } from '../src/tools/secrets.ts'

test('file kredensial dikenali di direktori mana pun', () => {
  for (const path of [
    '.env',
    '.env.local',
    '.env.production',
    'config/.env.staging',
    'server.pem',
    'private.key',
    'deep/nested/id_rsa',
    '.npmrc',
    '.git-credentials',
    'service-account.json',
    'secrets.yaml',
  ]) {
    assert.equal(isSensitivePath(path), true, `${path} seharusnya dianggap rahasia`)
  }
})

test('berkas contoh tetap boleh dibaca', () => {
  for (const path of ['.env.example', '.env.sample', '.env.template', 'config.dist']) {
    assert.equal(isSensitivePath(path), false, `${path} seharusnya aman`)
  }
})

test('berkas biasa tidak ikut tertolak', () => {
  for (const path of ['src/App.tsx', 'README.md', 'package.json', 'keyboard.ts', 'monkey.js']) {
    assert.equal(isSensitivePath(path), false, `${path} seharusnya aman`)
  }
})

test('read_file menolak .env dan tidak mengembalikan isinya', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'boo-secret-'))
  await writeFile(join(workspace, '.env'), 'API_KEY=sk-rahasia-sekali', 'utf8')

  const result = await readFileTool.run({ path: '.env' }, { workspace })

  assert.equal(result.isError, true)
  assert.doesNotMatch(result.content, /sk-rahasia-sekali/, 'isi kredensial tidak boleh bocor')
  assert.match(result.content, /Ditolak/)
})

test('edit_file menolak .env tanpa menyentuh berkasnya', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'boo-secret-'))
  await writeFile(join(workspace, '.env'), 'API_KEY=sk-rahasia', 'utf8')

  const result = await editFileTool.run(
    { path: '.env', old_text: 'sk-rahasia', new_text: 'diubah' },
    { workspace },
  )

  assert.equal(result.isError, true)
  assert.doesNotMatch(result.content, /sk-rahasia/)
})

test('read_file tetap melayani .env.example', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'boo-secret-'))
  await writeFile(join(workspace, '.env.example'), 'API_KEY=ganti-ini', 'utf8')

  const result = await readFileTool.run({ path: '.env.example' }, { workspace })

  assert.notEqual(result.isError, true)
  assert.match(result.content, /API_KEY/)
})
