/**
 * Aplikasi lokal yang boleh dibuka Boo.
 *
 * Model tidak pernah menerima command atau argumen bebas untuk launcher ini.
 * Ia hanya dapat memilih `id` yang sudah didaftarkan pengguna pada apps.json.
 * Konfigurasi tersebut adalah batas kepercayaan: ia dapat berisi executable
 * organisasi sendiri, tetapi tidak dapat diubah oleh tool ini.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import type { Tool } from '../domain/tool.ts'

export type AppPlatform = 'darwin' | 'win32' | 'linux'

export interface AppLaunch {
  command: string
  args?: string[]
}

export interface AppDefinition extends AppLaunch {
  id: string
  label?: string
  /** Menimpa command/args pada OS tertentu bila diperlukan. */
  platforms?: Partial<Record<AppPlatform, AppLaunch>>
}

export interface RegisteredApp extends Required<Pick<AppDefinition, 'id'>> {
  label: string
  command: string
  args: string[]
}

export interface AppCatalog {
  apps: RegisteredApp[]
  issues: string[]
}

/** Berkas pribadi dan berkas proyek; yang proyek menimpa alias yang sama. */
export const GLOBAL_APPS_PATH = join(homedir(), '.boo', 'apps.json')
export const WORKSPACE_APPS_DIRECTORY = '.boo'
export const WORKSPACE_APPS_FILENAME = 'apps.json'

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/
const PLATFORMS = new Set<AppPlatform>(['darwin', 'win32', 'linux'])

function nonEmptyText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text && !text.includes('\0') ? text : null
}

function argumentList(value: unknown): string[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value)) return null
  const args: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item.includes('\0')) return null
    args.push(item)
  }
  return args
}

function launch(value: unknown): AppLaunch | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const command = nonEmptyText(record.command)
  const args = argumentList(record.args)
  return command && args ? { command, args } : null
}

function normalize(value: unknown, platform: NodeJS.Platform): RegisteredApp | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const id = nonEmptyText(record.id)?.toLowerCase()
  if (!id || !ID.test(id)) return null

  const base = launch(record)
  const platformOverrides = record.platforms
  let selected: AppLaunch | null = null
  if (platformOverrides && typeof platformOverrides === 'object' && !Array.isArray(platformOverrides) && PLATFORMS.has(platform as AppPlatform)) {
    selected = launch((platformOverrides as Record<string, unknown>)[platform])
  }
  const resolved = selected ?? base
  if (!resolved) return null
  const label = nonEmptyText(record.label) ?? id
  return { id, label, command: resolved.command, args: resolved.args ?? [] }
}

function readDefinitions(path: string, issues: string[]): unknown[] {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return []
    issues.push(`${path}: tidak dapat dibaca.`)
    return []
  }
  try {
    const parsed = JSON.parse(raw) as { apps?: unknown }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.apps)) {
      issues.push(`${path}: harus berisi objek { "apps": [...] }.`)
      return []
    }
    return parsed.apps
  } catch {
    issues.push(`${path}: JSON tidak valid.`)
    return []
  }
}

/**
 * Memuat aplikasi yang eksplisit diizinkan. Tidak ada discovery executable atau
 * fallback nama aplikasi: keduanya bisa membuka program yang tidak dimaksud.
 */
export function loadApps(
  workspace: string,
  home = homedir(),
  platform: NodeJS.Platform = process.platform,
): AppCatalog {
  const issues: string[] = []
  const entries = new Map<string, RegisteredApp>()
  const paths = [join(home, '.boo', 'apps.json'), join(workspace, WORKSPACE_APPS_DIRECTORY, WORKSPACE_APPS_FILENAME)]
  for (const path of paths) {
    for (const candidate of readDefinitions(path, issues)) {
      const app = normalize(candidate, platform)
      if (!app) {
        issues.push(`${path}: satu aplikasi diabaikan karena id, command, atau args tidak valid untuk ${platform}.`)
        continue
      }
      entries.set(app.id, app)
    }
  }
  return { apps: [...entries.values()].sort((left, right) => left.label.localeCompare(right.label)), issues }
}

export function findApp(catalog: AppCatalog, id: string): RegisteredApp | null {
  const normalized = id.trim().toLowerCase()
  return catalog.apps.find((app) => app.id === normalized) ?? null
}

/** Memulai aplikasi terdaftar tanpa melewatkan string melalui shell. */
export function launchApp(app: RegisteredApp, cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      if (error) reject(error)
      else resolve()
    }
    try {
      const child = spawn(app.command, app.args, {
        cwd,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
      child.once('error', (error) => finish(error))
      child.once('spawn', () => {
        child.unref()
        finish()
      })
    } catch (error) {
      finish(error instanceof Error ? error : new Error('Aplikasi tidak dapat dimulai.'))
    }
  })
}

const LIST_DESCRIPTION = `List local applications explicitly registered by the user for Boo. Use this before open_app. The list is read from ~/.boo/apps.json and <workspace>/.boo/apps.json; it does not discover arbitrary programs.`
const OPEN_DESCRIPTION = `Open one local application registered by the user. Use list_apps first and pass only its id. This always requires user approval. It starts the registered executable directly, never through a shell.`

export const listAppsTool: Tool = {
  name: 'list_apps',
  description: LIST_DESCRIPTION,
  risk: 'safe',
  schema: {
    type: 'function',
    function: { name: 'list_apps', description: LIST_DESCRIPTION, parameters: { type: 'object', properties: {} } },
  },
  preview: () => 'lihat aplikasi terdaftar',
  async run(_args, context) {
    const catalog = loadApps(context.workspace)
    const apps = catalog.apps.length
      ? catalog.apps.map((app) => `- ${app.id}: ${app.label}`).join('\n')
      : '(Belum ada aplikasi terdaftar.)'
    const hint = 'Daftarkan alias pada ~/.boo/apps.json atau <workspace>/.boo/apps.json.'
    return { content: [apps, hint, ...catalog.issues].join('\n') }
  },
}

interface OpenArgs { id: string }

export const openAppTool: Tool<OpenArgs> = {
  name: 'open_app',
  description: OPEN_DESCRIPTION,
  risk: 'confirm',
  schema: {
    type: 'function',
    function: {
      name: 'open_app',
      description: OPEN_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Registered application id from list_apps' } },
        required: ['id'],
      },
    },
  },
  preview: (args) => `buka aplikasi ${args.id}`,
  async run(args, context) {
    const catalog = loadApps(context.workspace)
    const app = findApp(catalog, args.id)
    if (!app) return { content: `Gagal: aplikasi "${args.id}" tidak terdaftar untuk sistem ini. Gunakan list_apps terlebih dahulu.`, isError: true }
    try {
      await launchApp(app, context.workspace)
      return { content: `Aplikasi ${app.label} sedang dibuka.` }
    } catch (error) {
      return { content: `Gagal membuka ${app.label}: ${error instanceof Error ? error.message : 'kesalahan tidak dikenal'}`, isError: true }
    }
  },
}
