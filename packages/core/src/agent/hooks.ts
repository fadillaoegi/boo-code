/** Lifecycle hooks lokal dengan discovery aman dan eksekusi melalui sandbox Boo. */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { isSensitivePath } from '../tools/secrets.ts'
import type { SandboxPolicy } from '../tools/sandbox.ts'
import { resolveShell, runCommand } from '../tools/shell.ts'

export const HOOK_CONFIG_PATH = '.boo/hooks.json'
export const MAX_HOOK_CONFIG_BYTES = 64 * 1024
export const MAX_HOOKS = 50
export const HOOK_COMPLETION_MARK = '[Boo on_complete hook feedback]'

export type HookEvent = 'before_tool' | 'after_tool' | 'on_complete'

export interface HookDefinition {
  id: string
  event: HookEvent
  matcher: string
  command: string
  timeoutSeconds: number
  mutatesWorkspace: boolean
  verifiesWorkspace: boolean
  source: 'global' | 'project'
  label: string
}

export interface HookCommandResult {
  content: string
  success: boolean
  cancelled: boolean
}

interface RawHook {
  id?: unknown
  matcher?: unknown
  command?: unknown
  timeout?: unknown
  mutates_workspace?: unknown
  verifies_workspace?: unknown
}

function isInside(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)
}

function projectRoot(workspace: string): string {
  let directory = resolve(workspace)
  for (;;) {
    if (existsSync(join(directory, '.git'))) return directory
    const parent = dirname(directory)
    if (parent === directory) return resolve(workspace)
    directory = parent
  }
}

function directoriesBetween(root: string, workspace: string): string[] {
  const found = [root]
  let current = root
  const rest = relative(root, workspace)
  if (!rest) return found
  for (const segment of rest.split(sep)) { current = join(current, segment); found.push(current) }
  return found
}

function timeout(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(1, Math.min(120, Math.round(value))) : 30
}

/** Parser diekspor agar konfigurasi dapat diuji tanpa menjalankan command. */
export function parseHooks(raw: unknown, source: HookDefinition['source'], label: string): HookDefinition[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
  const groups = (raw as { hooks?: unknown }).hooks
  if (!groups || typeof groups !== 'object' || Array.isArray(groups)) return []
  const hooks: HookDefinition[] = []
  for (const event of ['before_tool', 'after_tool', 'on_complete'] as const) {
    const entries = (groups as Record<string, unknown>)[event]
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      if (hooks.length >= MAX_HOOKS || !entry || typeof entry !== 'object') continue
      const value = entry as RawHook
      if (typeof value.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(value.id)) continue
      if (typeof value.command !== 'string' || !value.command.trim() || value.command.length > 2_000 || /[\r\n\0]/.test(value.command)) continue
      const matcher = event === 'on_complete' ? '*' : value.matcher === undefined ? '*' : value.matcher
      if (typeof matcher !== 'string' || !/^[a-z0-9_*?-]{1,80}$/i.test(matcher)) continue
      if (value.mutates_workspace !== undefined && typeof value.mutates_workspace !== 'boolean') continue
      if (value.verifies_workspace !== undefined && typeof value.verifies_workspace !== 'boolean') continue
      hooks.push({
        id: value.id,
        event,
        matcher,
        command: value.command.trim(),
        timeoutSeconds: timeout(value.timeout),
        mutatesWorkspace: value.mutates_workspace === true,
        verifiesWorkspace: value.verifies_workspace === true,
        source,
        label,
      })
    }
  }
  return hooks
}

function readConfig(path: string, allowedRoot: string, source: HookDefinition['source'], label: string): HookDefinition[] {
  let real: string
  try {
    real = realpathSync(path)
    const info = statSync(real)
    if (!info.isFile() || info.size > MAX_HOOK_CONFIG_BYTES || !isInside(real, realpathSync(allowedRoot)) || isSensitivePath(real)) return []
  } catch { return [] }
  try { return parseHooks(JSON.parse(readFileSync(real, 'utf8')) as unknown, source, label) } catch { return [] }
}

/** Hook dengan event+id sama yang paling dekat ke workspace menimpa induknya. */
export function loadHooks(workspace: string, home?: string): HookDefinition[] {
  const root = resolve(workspace)
  const byId = new Map<string, HookDefinition>()
  if (home) {
    const globalRoot = join(home, '.boo')
    for (const hook of readConfig(join(globalRoot, 'hooks.json'), globalRoot, 'global', '~/.boo/hooks.json')) byId.set(`${hook.event}:${hook.id}`, hook)
  }
  const top = projectRoot(root)
  for (const directory of directoriesBetween(top, root)) {
    const config = join(directory, HOOK_CONFIG_PATH)
    const label = relative(root, config).split(sep).join('/')
    for (const hook of readConfig(config, top, 'project', label)) byId.set(`${hook.event}:${hook.id}`, hook)
  }
  return [...byId.values()].slice(0, MAX_HOOKS)
}

export function hookMatches(hook: HookDefinition, event: HookEvent, toolName?: string): boolean {
  if (hook.event !== event) return false
  if (event === 'on_complete') return true
  const escaped = hook.matcher.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`, 'i').test(toolName ?? '')
}

export async function runHookCommand(
  hook: HookDefinition,
  options: { workspace: string; sandbox?: SandboxPolicy; signal?: AbortSignal },
): Promise<HookCommandResult> {
  const result = await runCommand(hook.command, {
    cwd: options.workspace,
    shell: resolveShell(),
    sandbox: options.sandbox ?? { mode: 'workspace-write' },
    timeoutMs: hook.timeoutSeconds * 1_000,
    ...(options.signal ? { signal: options.signal } : {}),
  })
  if (result.cancelled) return { content: 'Hook dibatalkan.', success: false, cancelled: true }
  if (result.spawnError) return { content: `Hook gagal dijalankan: ${result.spawnError}`, success: false, cancelled: false }
  if (result.timedOut) return { content: `Hook melewati timeout ${hook.timeoutSeconds} detik.${result.output ? `\n${result.output}` : ''}`, success: false, cancelled: false }
  if (result.exitCode !== 0) return { content: `Hook gagal (exit ${result.exitCode ?? '?'}):\n${result.output || '(tanpa keluaran)'}`, success: false, cancelled: false }
  return { content: result.output || '(tanpa keluaran)', success: true, cancelled: false }
}

export function completionHookFeedback(content: string): string | null {
  return content.startsWith(`${HOOK_COMPLETION_MARK}\n`) ? content.slice(HOOK_COMPLETION_MARK.length + 1).trim() || null : null
}
