/** OS-level command sandbox launchers for macOS, Linux, and Windows. */

import { existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commandEnvironment } from './commandEnvironment.ts'
import type { Shell } from './shell.ts'
import {
  encodeWindowsSandboxConfig,
  ensureWindowsSandboxTemporaryDirectory,
  probeWindowsSandbox,
  resolveWindowsSandboxExecutable,
  windowsSandboxConfig,
} from './windowsSandbox.ts'

export type SandboxMode = 'workspace-write' | 'read-only' | 'danger-full-access'
export type SandboxBackend = 'seatbelt' | 'bubblewrap' | 'windows-appcontainer' | 'none'

export interface SandboxPolicy {
  mode: SandboxMode
  /** Network stays blocked in enforced sandboxes unless explicitly enabled. */
  networkAccess?: boolean
}

export interface SandboxStatus {
  mode: SandboxMode
  backend: SandboxBackend
  enforced: boolean
  networkAccess: boolean
  reason?: string
}

export interface SandboxLaunch {
  file: string
  args: string[]
  status: SandboxStatus
}

const PROTECTED_DIRECTORIES = ['.git', '.boo', '.codex', '.agents']

export function isProtectedWorkspacePath(path: string): boolean {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts.some((part) => PROTECTED_DIRECTORIES.includes(part.toLowerCase()))
}

export function isSandboxMode(value: unknown): value is SandboxMode {
  return value === 'workspace-write' || value === 'read-only' || value === 'danger-full-access'
}

export function resolveSandboxPolicy(mode: unknown, networkAccess: unknown): SandboxPolicy {
  return {
    mode: isSandboxMode(mode) ? mode : 'workspace-write',
    networkAccess: typeof networkAccess === 'string'
      ? /^(?:1|true|yes|on)$/i.test(networkAccess.trim())
      : networkAccess === true,
  }
}

/** Scheme string literal accepted by sandbox-exec profiles. */
function scheme(value: string): string {
  return JSON.stringify(value)
}

function existingProtectedPaths(workspace: string): string[] {
  return PROTECTED_DIRECTORIES
    .map((name) => join(workspace, name))
    .filter((path) => existsSync(path))
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

function seatbeltProfile(workspace: string, policy: SandboxPolicy): string {
  const temporary = realpathOrSelf(tmpdir())
  const writeRules = policy.mode === 'workspace-write'
    ? [`(allow file-write* (subpath ${scheme(workspace)}))`]
    : []
  const protectedRules = existingProtectedPaths(workspace).map((path) => `(deny file-write* (subpath ${scheme(path)}))`)
  return [
    '(version 1)',
    '(deny default)',
    '(allow process*)',
    '(allow signal (target same-sandbox))',
    '(allow sysctl-read)',
    '(allow file-read*)',
    '(allow file-write* (literal "/dev/null"))',
    '(allow file-write* (literal "/dev/tty"))',
    `(allow file-write* (subpath ${scheme(temporary)}))`,
    ...writeRules,
    ...protectedRules,
    ...(policy.networkAccess ? ['(allow network*)'] : []),
  ].join('\n')
}

function raw(shell: Shell, command: string, policy: SandboxPolicy, reason?: string): SandboxLaunch {
  return {
    file: shell.file,
    args: shell.args(command),
    status: {
      mode: policy.mode,
      backend: 'none',
      enforced: false,
      networkAccess: policy.mode === 'danger-full-access' || Boolean(policy.networkAccess),
      ...(reason ? { reason } : {}),
    },
  }
}

export function sandboxLaunch(
  shell: Shell,
  command: string,
  workspace: string,
  policy: SandboxPolicy,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
  environment: NodeJS.ProcessEnv = commandEnvironment(),
): SandboxLaunch {
  if (policy.mode === 'danger-full-access') return raw(shell, command, policy, 'Sandbox dinonaktifkan oleh konfigurasi.')

  const root = realpathOrSelf(workspace)
  if (platform === 'darwin' && exists('/usr/bin/sandbox-exec')) {
    return {
      file: '/usr/bin/sandbox-exec',
      args: ['-p', seatbeltProfile(root, policy), shell.file, ...shell.args(command)],
      status: {
        mode: policy.mode,
        backend: 'seatbelt',
        enforced: true,
        networkAccess: Boolean(policy.networkAccess),
      },
    }
  }

  if (platform === 'linux') {
    const bwrap = ['/usr/bin/bwrap', '/bin/bwrap'].find(exists)
    if (bwrap) {
      const temporary = realpathOrSelf(tmpdir())
      const args = [
        '--die-with-parent', '--new-session',
        '--ro-bind', '/', '/',
        '--proc', '/proc', '--dev', '/dev',
        '--bind', temporary, temporary,
        ...(policy.mode === 'workspace-write' ? ['--bind', root, root] : []),
        ...existingProtectedPaths(root).flatMap((path) => ['--ro-bind', path, path]),
        ...(policy.networkAccess ? [] : ['--unshare-net']),
        '--chdir', root,
        shell.file, ...shell.args(command),
      ]
      return {
        file: bwrap,
        args,
        status: {
          mode: policy.mode,
          backend: 'bubblewrap',
          enforced: true,
          networkAccess: Boolean(policy.networkAccess),
        },
      }
    }
    return raw(shell, command, policy, 'bubblewrap (bwrap) tidak tersedia; command tetap memerlukan approval pengguna.')
  }

  if (platform === 'win32') {
    const resolved = resolveWindowsSandboxExecutable(environment, process.arch, exists)
    if (!resolved.executable) {
      return raw(shell, command, policy, `${resolved.reason ?? 'Windows ProcessContainer tidak tersedia'}; command tetap memerlukan approval pengguna.`)
    }
    if (process.platform === 'win32') {
      const probe = probeWindowsSandbox(resolved.executable)
      if (!probe.supported) {
        return raw(shell, command, policy, `Windows ProcessContainer tidak siap: ${probe.reason || 'probe MXC gagal'}; command tetap memerlukan approval pengguna.`)
      }
    }
    const temporary = ensureWindowsSandboxTemporaryDirectory()
    const config = windowsSandboxConfig(shell, command, root, policy, environment, temporary, exists, PROTECTED_DIRECTORIES)
    return {
      file: resolved.executable,
      args: ['--config-base64', encodeWindowsSandboxConfig(config)],
      status: {
        mode: policy.mode,
        backend: 'windows-appcontainer',
        enforced: true,
        networkAccess: Boolean(policy.networkAccess),
      },
    }
  }
  return raw(shell, command, policy, `Sandbox tidak tersedia untuk platform ${platform}; command tetap memerlukan approval pengguna.`)
}

/** Nilai status tanpa perlu memulai proses; dipakai untuk pesan latar belakang. */
export function inspectSandbox(workspace: string, policy: SandboxPolicy, platform: NodeJS.Platform = process.platform): SandboxStatus {
  const placeholder: Shell = { file: '', name: '', args: () => [] }
  return sandboxLaunch(placeholder, '', workspace, policy, platform).status
}
