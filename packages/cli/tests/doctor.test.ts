import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { diagnoseBoo, doctorExitCode, type DoctorOptions } from '../src/doctor.ts'

async function options(overrides: Partial<DoctorOptions> = {}): Promise<DoctorOptions> {
  const workspace = await mkdtemp(join(tmpdir(), 'boo-doctor-'))
  return {
    workspace,
    configPath: join(workspace, '.boo-env'),
    config: { NINEROUTER_URL: 'http://127.0.0.1:20128', NINEROUTER_KEY: 'super-secret-key', BOO_MODEL: 'auto' },
    sandbox: { mode: 'workspace-write', backend: 'seatbelt', enforced: true, networkAccess: false },
    nodeVersion: '24.4.0',
    platform: 'darwin',
    ...overrides,
  }
}

test('doctor memeriksa instalasi tanpa menampilkan credential', async () => {
  const input = await options()
  const checks = await diagnoseBoo(input, {
    accessWorkspace: async () => undefined,
    configMode: async () => 0o600,
    listModels: async (url, key) => {
      assert.equal(url, 'http://127.0.0.1:20128/')
      assert.equal(key, 'super-secret-key')
      return ['ag/gemini-3.1-pro', 'cx/gpt-5.6-sol']
    },
    command: (file, args) => {
      if (file === 'git' && args[0] === '--version') return { ok: true, output: 'git version 2.50.0' }
      if (file === 'git') return { ok: true, output: 'true' }
      return { ok: true, output: 'ripgrep 14.1.0' }
    },
    browser: async () => 'Browser CDP siap dengan 2 tab halaman.',
  })

  assert.equal(doctorExitCode(checks), 0)
  assert.ok(checks.every((check) => check.status === 'pass'))
  assert.doesNotMatch(JSON.stringify(checks), /super-secret-key/)
  assert.equal(checks.find((check) => check.id === 'provider')?.detail, '2 model tersedia')
})

test('doctor membedakan kegagalan wajib dari integrasi opsional', async () => {
  const input = await options({
    nodeVersion: '20.18.0',
    config: { NINEROUTER_URL: 'bukan-url', BOO_MODEL: 'manual-model' },
    sandbox: { mode: 'workspace-write', backend: 'none', enforced: false, networkAccess: true, reason: 'backend tidak tersedia' },
  })
  let providerCalled = false
  const checks = await diagnoseBoo(input, {
    accessWorkspace: async () => { throw new Error('permission denied') },
    configMode: async () => 0o644,
    listModels: async () => { providerCalled = true; return [] },
    command: () => ({ ok: false, output: 'not found' }),
    browser: async () => { throw new Error('connection refused') },
  })

  assert.equal(providerCalled, false)
  assert.equal(doctorExitCode(checks), 1)
  for (const id of ['runtime', 'workspace', 'provider-config']) assert.equal(checks.find((check) => check.id === id)?.status, 'fail')
  for (const id of ['provider', 'git', 'repository', 'ripgrep', 'sandbox', 'browser']) assert.equal(checks.find((check) => check.id === id)?.status, 'warn')
  assert.match(checks.find((check) => check.id === 'config-file')?.detail ?? '', /644.*600/)
})

test('doctor memperingatkan model manual yang hilang dari provider', async () => {
  const input = await options({ config: { NINEROUTER_URL: 'https://router.example', NINEROUTER_KEY: 'secret', BOO_MODEL: 'model-lama' } })
  const checks = await diagnoseBoo(input, {
    configMode: async () => null,
    listModels: async () => ['model-baru'],
    command: (file, args) => file === 'git' && args[0] !== '--version'
      ? { ok: false, output: 'false' }
      : { ok: true, output: file === 'git' ? 'git version 2.50.0' : 'ripgrep 14.1.0' },
    browser: async () => { throw new Error('tidak aktif') },
  })
  assert.equal(checks.find((check) => check.id === 'model')?.status, 'warn')
  assert.match(checks.find((check) => check.id === 'model')?.detail ?? '', /model-lama/)
  assert.equal(doctorExitCode(checks), 0)
})

test('error provider yang mengulang kunci tetap disamarkan', async () => {
  const apiKey = 'key-that-must-stay-private'
  const input = await options({ config: { NINEROUTER_URL: 'https://router.example', NINEROUTER_KEY: apiKey, BOO_MODEL: 'auto' } })
  const checks = await diagnoseBoo(input, {
    configMode: async () => 0o600,
    listModels: async () => { throw new Error(`unauthorized ${apiKey}`) },
    command: () => ({ ok: false, output: '' }),
    browser: async () => { throw new Error('tidak aktif') },
  })
  assert.equal(checks.find((check) => check.id === 'provider')?.status, 'fail')
  assert.match(checks.find((check) => check.id === 'provider')?.detail ?? '', /\[disembunyikan\]/)
  assert.doesNotMatch(JSON.stringify(checks), new RegExp(apiKey))
})

test('boo-code doctor berjalan tanpa memulai sesi atau menampilkan kunci', { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'boo-doctor-cli-'))
  const server = createServer((request, response) => {
    assert.equal(request.url, '/v1/models')
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ data: [{ id: 'ag/gemini-3.1-pro' }] }))
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as AddressInfo).port
  const apiKey = 'doctor-secret-never-print'
  const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'src', 'index.ts'), 'doctor'], {
    cwd: directory,
    env: { ...process.env, HOME: directory, NINEROUTER_URL: `http://127.0.0.1:${port}`, NINEROUTER_KEY: apiKey, BOO_MODEL: 'auto' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString() })
  try {
    const [exitCode] = await once(child, 'close')
    assert.equal(exitCode, 0, output)
    assert.match(output, /Boo Code doctor/)
    assert.match(output, /Koneksi 9Router.*1 model tersedia/)
    assert.doesNotMatch(output, new RegExp(apiKey))
    assert.doesNotMatch(output, /ketik perintah, \/help/)
  } finally {
    if (child.exitCode === null) child.kill()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
})
