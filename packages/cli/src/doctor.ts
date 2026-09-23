/** Pemeriksaan instalasi Boo tanpa membaca source, prompt, cookie, atau credential. */

import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { browserStatus, loadComputerBridge, loadRemoteNodes, loadSchedules, NineRouterProvider, profilesFromConfig, splitModelId, type SandboxStatus } from '@boo/core'

export type DoctorCheckStatus = 'pass' | 'warn' | 'fail'

export interface DoctorCheck {
  id: string
  label: string
  status: DoctorCheckStatus
  detail: string
}

export interface DoctorConfig {
  NINEROUTER_URL?: string
  NINEROUTER_KEY?: string
  BOO_MODEL?: string
  /** Kunci dan alamat penyedia lain, misalnya ANTHROPIC_API_KEY. */
  [key: string]: string | undefined
}

export interface DoctorOptions {
  workspace: string
  config: DoctorConfig
  configPath: string
  sandbox: SandboxStatus
  home?: string
  nodeVersion?: string
  platform?: NodeJS.Platform
}

export interface DoctorDependencies {
  listModels?: (baseUrl: string, apiKey: string) => Promise<string[]>
  browser?: (home: string) => Promise<string>
  command?: (file: string, args: string[], cwd: string) => { ok: boolean; output: string }
  accessWorkspace?: (path: string) => Promise<void>
  configMode?: (path: string) => Promise<number | null>
}

/** Tarball hasil release ditargetkan dan diuji mulai Node 22.12. */
const MINIMUM_NODE = [22, 12, 0] as const

function clean(value: string, max = 240): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, max)
}

function errorDetail(error: unknown, secrets: string[] = []): string {
  let detail = error instanceof Error ? error.message : 'koneksi gagal'
  for (const secret of secrets) if (secret) detail = detail.replaceAll(secret, '[disembunyikan]')
  return clean(detail)
}

function versionParts(value: string): number[] {
  return value.split('.').slice(0, 3).map((part) => Number.parseInt(part, 10) || 0)
}

function supportedNode(value: string): boolean {
  const current = versionParts(value)
  for (let index = 0; index < MINIMUM_NODE.length; index += 1) {
    if (current[index] > MINIMUM_NODE[index]) return true
    if (current[index] < MINIMUM_NODE[index]) return false
  }
  return true
}

function defaultCommand(file: string, args: string[], cwd: string): { ok: boolean; output: string } {
  const result = spawnSync(file, args, { cwd, encoding: 'utf8', timeout: 3_000, windowsHide: true })
  return { ok: result.status === 0, output: clean(result.stdout || result.stderr || result.error?.message || '') }
}

async function defaultConfigMode(path: string): Promise<number | null> {
  try { return (await stat(path)).mode & 0o777 } catch { return null }
}

async function defaultWorkspaceAccess(path: string): Promise<void> {
  await access(path, constants.R_OK | constants.W_OK)
}

function pass(id: string, label: string, detail: string): DoctorCheck {
  return { id, label, status: 'pass', detail }
}

function warn(id: string, label: string, detail: string): DoctorCheck {
  return { id, label, status: 'warn', detail }
}

function fail(id: string, label: string, detail: string): DoctorCheck {
  return { id, label, status: 'fail', detail }
}

/** Menjalankan pemeriksaan berurutan agar hasil stabil dan mudah dibaca. */
export async function diagnoseBoo(options: DoctorOptions, dependencies: DoctorDependencies = {}): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = []
  const platform = options.platform ?? process.platform
  const nodeVersion = options.nodeVersion ?? process.versions.node
  checks.push(supportedNode(nodeVersion)
    ? pass('runtime', 'Runtime Node.js', `v${nodeVersion} (minimum v${MINIMUM_NODE.join('.')})`)
    : fail('runtime', 'Runtime Node.js', `v${nodeVersion}; Boo memerlukan v${MINIMUM_NODE.join('.')} atau lebih baru`))

  try {
    await (dependencies.accessWorkspace ?? defaultWorkspaceAccess)(options.workspace)
    checks.push(pass('workspace', 'Workspace', 'dapat dibaca dan ditulis'))
  } catch (error) {
    checks.push(fail('workspace', 'Workspace', clean(error instanceof Error ? error.message : 'tidak dapat dibaca/ditulis')))
  }

  // Penyedia lain — OpenAI, Anthropic, OpenRouter, Ollama, alamat sendiri —
  // membuat 9Router tidak lagi wajib; yang wajib adalah ada penyedia yang bisa dipakai.
  const profiles = profilesFromConfig(options.config)
  const others = profiles.filter((profile) => profile.id !== 'ninerouter')
  checks.push(profiles.length
    ? pass('providers', 'Penyedia model', profiles.map((profile) => profile.label).join(', '))
    : fail('providers', 'Penyedia model', 'belum ada yang dikonfigurasi; jalankan boo-code setup'))

  let baseUrl = ''
  try {
    const parsed = new URL(options.config.NINEROUTER_URL ?? '')
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('harus berupa URL HTTP(S) tanpa credential tertanam')
    baseUrl = parsed.href
  } catch (error) {
    checks.push(fail('provider-config', 'Konfigurasi 9Router', clean(error instanceof Error ? error.message : 'alamat tidak valid')))
  }
  const apiKey = options.config.NINEROUTER_KEY?.trim() ?? ''
  if (baseUrl && apiKey) checks.push(pass('provider-config', 'Konfigurasi 9Router', 'alamat dan kunci API tersedia; nilai kunci tidak ditampilkan'))
  else if (baseUrl) {
    checks.push(others.length
      ? warn('provider-config', 'Konfigurasi 9Router', `NINEROUTER_KEY belum diatur; memakai ${others.map((profile) => profile.label).join(', ')}`)
      : fail('provider-config', 'Konfigurasi 9Router', 'NINEROUTER_KEY belum diatur'))
  }

  const mode = await (dependencies.configMode ?? defaultConfigMode)(options.configPath)
  if (mode === null) {
    checks.push(warn('config-file', 'Berkas konfigurasi global', 'tidak ada; konfigurasi mungkin berasal dari workspace atau environment'))
  } else if (platform !== 'win32' && (mode & 0o077) !== 0) {
    checks.push(warn('config-file', 'Izin berkas konfigurasi', `mode ${mode.toString(8)}; disarankan 600`))
  } else {
    checks.push(pass('config-file', 'Izin berkas konfigurasi', platform === 'win32' ? 'tersedia (ACL dikelola Windows)' : `mode ${mode.toString(8)}`))
  }

  let models: string[] = []
  if (baseUrl && apiKey) {
    try {
      const listModels = dependencies.listModels ?? ((url: string, key: string) => new NineRouterProvider({ baseUrl: url, apiKey: key, model: '', timeoutMs: 10_000 }).listModels())
      models = await listModels(baseUrl, apiKey)
      checks.push(models.length
        ? pass('provider', 'Koneksi 9Router', `${models.length} model tersedia`)
        : warn('provider', 'Koneksi 9Router', 'terhubung, tetapi daftar model kosong'))
    } catch (error) {
      checks.push(fail('provider', 'Koneksi 9Router', errorDetail(error, [apiKey])))
    }
  } else {
    checks.push(warn('provider', 'Koneksi 9Router', others.length ? 'dilewati; penyedia lain yang dipakai' : 'dilewati karena konfigurasi belum lengkap'))
  }

  const configuredModel = options.config.BOO_MODEL?.trim() || 'auto'
  if (configuredModel === 'auto') checks.push(pass('model', 'Model bawaan', 'Auto'))
  else if (models.length && !models.includes(configuredModel) && !splitModelId(configuredModel).providerId) checks.push(warn('model', 'Model bawaan', `${configuredModel} tidak ada dalam daftar provider saat ini`))
  else checks.push(pass('model', 'Model bawaan', configuredModel))

  const command = dependencies.command ?? defaultCommand
  const git = command('git', ['--version'], options.workspace)
  checks.push(git.ok ? pass('git', 'Git', git.output || 'tersedia') : warn('git', 'Git', git.output || 'tidak ditemukan; fitur repository akan terbatas'))
  const repository = git.ok ? command('git', ['rev-parse', '--is-inside-work-tree'], options.workspace) : { ok: false, output: '' }
  checks.push(repository.ok && repository.output === 'true'
    ? pass('repository', 'Repository', 'workspace berada di dalam Git repository')
    : warn('repository', 'Repository', 'workspace bukan Git repository; fitur diff/review tetap terbatas'))
  const ripgrep = command('rg', ['--version'], options.workspace)
  checks.push(ripgrep.ok ? pass('ripgrep', 'Ripgrep', ripgrep.output.split(' ').slice(0, 2).join(' ') || 'tersedia') : warn('ripgrep', 'Ripgrep', 'tidak ditemukan; pencarian internal Boo tetap tersedia'))

  if (options.sandbox.enforced) {
    checks.push(pass('sandbox', 'Sandbox command', `${options.sandbox.mode} · ${options.sandbox.backend} · network ${options.sandbox.networkAccess ? 'on' : 'off'}`))
  } else {
    checks.push(warn('sandbox', 'Sandbox command', `${options.sandbox.mode} tidak enforced${options.sandbox.reason ? `: ${clean(options.sandbox.reason)}` : ''}`))
  }

  const home = options.home ?? homedir()
  const computer = loadComputerBridge(home, platform)
  checks.push(computer
    ? pass('computer-use', 'Computer use native', `bridge ${platform} terdaftar; izin accessibility tetap diperiksa saat dipakai`)
    : pass('computer-use', 'Computer use native', `opsional; bridge ${platform} belum terdaftar di ~/.boo/computer.json`))
  const schedules = loadSchedules(home).jobs
  checks.push(schedules.length
    ? pass('scheduler', 'Background scheduler', `${schedules.filter((job) => job.enabled).length}/${schedules.length} task aktif; jalankan boo-code daemon`)
    : pass('scheduler', 'Background scheduler', 'siap; belum ada task terjadwal'))
  const nodes = loadRemoteNodes(home).nodes
  checks.push(nodes.length
    ? pass('remote-nodes', 'Remote device nodes', `${nodes.length} node dipasangkan; token tidak ditampilkan`)
    : pass('remote-nodes', 'Remote device nodes', 'siap; belum ada node dipasangkan'))

  try {
    const browser = dependencies.browser ?? ((home: string) => browserStatus(home))
    checks.push(pass('browser', 'Browser CDP opsional', clean(await browser(home))))
  } catch (error) {
    checks.push(warn('browser', 'Browser CDP opsional', clean(error instanceof Error ? error.message : 'tidak aktif')))
  }

  return checks
}

export function doctorExitCode(checks: readonly DoctorCheck[]): number {
  return checks.some((check) => check.status === 'fail') ? 1 : 0
}
