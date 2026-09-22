/** Aturan izin persisten yang dimuat dari berkas pribadi dan proyek. */

import { readFileSync, realpathSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

export const GLOBAL_PERMISSIONS_FILENAME = 'permissions.json'
export const PROJECT_PERMISSIONS_PATH = '.boo/permissions.json'
export const MAX_PERMISSION_CONFIG_BYTES = 64 * 1024
export const MAX_PERMISSION_RULES = 100

export type PermissionEffect = 'allow' | 'ask' | 'deny'
export type PermissionSource = 'global' | 'project'

export interface PermissionRule {
  id: string
  effect: PermissionEffect
  tool: string
  command?: string
  path?: string
  app?: string
  domain?: string
  source: PermissionSource
  label: string
}

export interface PermissionPolicy {
  rules: PermissionRule[]
  issues: string[]
  globalPath: string
  projectPath: string
}

export interface PermissionMatch {
  effect: PermissionEffect
  rule: PermissionRule
}

export interface PermissionSafety {
  /** False untuk tool yang kontraknya mewajibkan persetujuan baru setiap aksi. */
  allowAlways: boolean
  /** Tindakan memulai proses lokal dan karenanya memerlukan sandbox enforced. */
  commandAction: boolean
  sandbox?: { enforced: boolean; mode: string }
}

interface RawRule {
  id?: unknown
  effect?: unknown
  tool?: unknown
  command?: unknown
  path?: unknown
  app?: unknown
  domain?: unknown
}

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i
const TOOL_PATTERN = /^[a-z0-9_*?-]{1,80}$/i
const EFFECTS = new Set<PermissionEffect>(['allow', 'ask', 'deny'])
const OPTIONAL_PATTERNS = ['command', 'path', 'app', 'domain'] as const

function inside(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
}

function pattern(value: unknown, maximum = 500): string | undefined | null {
  if (value === undefined) return undefined
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text && text.length <= maximum && !/[\0\r\n]/.test(text) ? text : null
}

/** Parser mandiri agar konfigurasi dapat diuji tanpa menyentuh HOME pengguna. */
export function parsePermissionRules(
  raw: unknown,
  source: PermissionSource,
  label: string,
): { rules: PermissionRule[]; issues: string[] } {
  const issues: string[] = []
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { rules: [], issues: [`${label}: harus berisi objek { "version": 1, "rules": [...] }.`] }
  }
  const document = raw as { version?: unknown; rules?: unknown }
  if (document.version !== 1 || !Array.isArray(document.rules)) {
    return { rules: [], issues: [`${label}: version harus 1 dan rules harus berupa array.`] }
  }

  const rules: PermissionRule[] = []
  for (let index = 0; index < document.rules.length; index += 1) {
    if (rules.length >= MAX_PERMISSION_RULES) {
      issues.push(`${label}: aturan setelah batas ${MAX_PERMISSION_RULES} diabaikan.`)
      break
    }
    const entry = document.rules[index]
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      issues.push(`${label}: rules[${index}] bukan objek yang sah.`)
      continue
    }
    const value = entry as RawRule
    const id = typeof value.id === 'string' && ID.test(value.id) ? value.id : `rule-${index + 1}`
    const effect = typeof value.effect === 'string' && EFFECTS.has(value.effect as PermissionEffect)
      ? value.effect as PermissionEffect
      : null
    const tool = pattern(value.tool, 80)
    if (!effect || !tool || !TOOL_PATTERN.test(tool)) {
      issues.push(`${label}: rules[${index}] diabaikan karena effect atau pola tool tidak sah.`)
      continue
    }
    if (source === 'project' && effect === 'allow') {
      issues.push(`${label}: aturan ${id} diabaikan; repository hanya boleh memakai ask atau deny.`)
      continue
    }

    const optional: Partial<Pick<PermissionRule, 'command' | 'path' | 'app' | 'domain'>> = {}
    let invalid = false
    for (const key of OPTIONAL_PATTERNS) {
      const parsed = pattern(value[key])
      if (parsed === null) invalid = true
      else if (parsed !== undefined) optional[key] = key === 'domain' ? parsed.toLowerCase() : parsed
    }
    if (invalid) {
      issues.push(`${label}: aturan ${id} diabaikan karena pola opsional tidak sah.`)
      continue
    }
    rules.push({ id, effect, tool: tool.toLowerCase(), ...optional, source, label })
  }
  return { rules, issues }
}

function readRules(path: string, root: string, source: PermissionSource, label: string): { rules: PermissionRule[]; issues: string[] } {
  let real: string
  try {
    real = realpathSync(path)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { rules: [], issues: [] }
      : { rules: [], issues: [`${label}: tidak dapat dibaca.`] }
  }
  try {
    const realRoot = realpathSync(root)
    const info = statSync(real)
    if (!info.isFile() || !inside(real, realRoot)) return { rules: [], issues: [`${label}: symlink atau lokasi di luar root ditolak.`] }
    if (info.size > MAX_PERMISSION_CONFIG_BYTES) return { rules: [], issues: [`${label}: melebihi batas 64 KiB.`] }
    return parsePermissionRules(JSON.parse(readFileSync(real, 'utf8')) as unknown, source, label)
  } catch {
    return { rules: [], issues: [`${label}: JSON tidak valid atau berkas tidak aman.`] }
  }
}

/** Memuat ulang aturan pada setiap keputusan supaya edit manual langsung berlaku. */
export function loadPermissionPolicy(options: { workspace: string; home: string }): PermissionPolicy {
  const globalPath = join(options.home, '.boo', GLOBAL_PERMISSIONS_FILENAME)
  const projectPath = resolve(options.workspace, PROJECT_PERMISSIONS_PATH)
  const global = readRules(globalPath, join(options.home, '.boo'), 'global', '~/.boo/permissions.json')
  const project = readRules(projectPath, resolve(options.workspace), 'project', PROJECT_PERMISSIONS_PATH)
  return {
    rules: [...global.rules, ...project.rules],
    issues: [...global.issues, ...project.issues],
    globalPath,
    projectPath,
  }
}

function glob(pattern: string, value: string, caseInsensitive = false): boolean {
  let source = '^'
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        if (pattern[index + 2] === '/') {
          source += '(?:.*/)?'
          index += 2
        } else {
          source += '.*'
          index += 1
        }
      } else source += '[^/]*'
    } else if (character === '?') source += '[^/]'
    else source += character.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
  }
  return new RegExp(`${source}$`, caseInsensitive ? 'i' : '').test(value)
}

function pathsOf(args: Record<string, unknown>): string[] {
  const paths: string[] = []
  if (typeof args.path === 'string') paths.push(args.path)
  if (Array.isArray(args.paths)) paths.push(...args.paths.filter((item): item is string => typeof item === 'string'))
  if (typeof args.patch === 'string') {
    for (const match of args.patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) paths.push(match[1])
  }
  return [...new Set(paths.map((path) => path.replaceAll('\\', '/').replace(/^\.\//, '')))]
}

function domainOf(args: Record<string, unknown>): string | null {
  if (typeof args.url !== 'string') return null
  try { return new URL(args.url).hostname.toLowerCase() } catch { return null }
}

function matches(rule: PermissionRule, tool: string, args: Record<string, unknown>): boolean {
  if (!glob(rule.tool, tool.toLowerCase(), true)) return false
  if (rule.command !== undefined) {
    if (typeof args.command !== 'string' || !glob(rule.command, args.command)) return false
  }
  if (rule.app !== undefined) {
    if (typeof args.id !== 'string' || !glob(rule.app, args.id, true)) return false
  }
  if (rule.domain !== undefined) {
    const domain = domainOf(args)
    if (!domain || !glob(rule.domain, domain, true)) return false
  }
  if (rule.path !== undefined) {
    const paths = pathsOf(args)
    if (!paths.length) return false
    // Allow hanya berlaku bila seluruh target berada dalam cakupan. Deny/ask
    // cukup cocok dengan satu target agar aturan yang lebih ketat tidak lolos.
    const pathMatches = (path: string) => glob(rule.path as string, path)
    if (rule.effect === 'allow' ? !paths.every(pathMatches) : !paths.some(pathMatches)) return false
  }
  return true
}

/** Deny selalu menang, lalu ask, lalu allow; urutan JSON tidak mengubah keamanan. */
export function evaluatePermission(
  policy: PermissionPolicy,
  request: { tool: string; args: Record<string, unknown> },
): PermissionMatch | null {
  const matching = policy.rules.filter((rule) => matches(rule, request.tool, request.args))
  for (const effect of ['deny', 'ask', 'allow'] as const) {
    const rule = matching.find((candidate) => candidate.effect === effect)
    if (rule) return { effect, rule }
  }
  return null
}

/**
 * Mengubah kecocokan berkas menjadi keputusan efektif tanpa memperlebar batas
 * keamanan tool atau sandbox. Null berarti tak ada aturan dan kebijakan UI biasa
 * boleh berlaku; allow yang tidak aman turun menjadi ask, bukan dijalankan.
 */
export function resolveConfiguredPermission(
  match: PermissionMatch | null,
  safety: PermissionSafety,
): PermissionEffect | null {
  if (!match) return null
  if (match.effect !== 'allow') return match.effect
  if (!safety.allowAlways) return 'ask'
  if (safety.commandAction && (!safety.sandbox?.enforced || safety.sandbox.mode === 'danger-full-access')) return 'ask'
  return 'allow'
}

export function permissionRuleLabel(rule: PermissionRule): string {
  const conditions = [
    `tool=${rule.tool}`,
    ...(rule.command ? [`command=${rule.command}`] : []),
    ...(rule.path ? [`path=${rule.path}`] : []),
    ...(rule.app ? [`app=${rule.app}`] : []),
    ...(rule.domain ? [`domain=${rule.domain}`] : []),
  ]
  return `${rule.id}: ${rule.effect} · ${conditions.join(' · ')} [${rule.source}]`
}
