/** Windows ProcessContainer launcher backed by Microsoft MXC. */

import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { arch, tmpdir } from 'node:os'
import { dirname, join, win32 } from 'node:path'
import type { Shell } from './shell.ts'
import type { SandboxMode, SandboxPolicy } from './sandbox.ts'

export const WINDOWS_SANDBOX_SCHEMA_VERSION = '0.8.0-alpha'
export const WINDOWS_SANDBOX_PACKAGE = '@microsoft/mxc-sdk'
export const WINDOWS_SANDBOX_TEMP_DIRECTORY = 'boo-sandbox'

export interface WindowsSandboxConfig {
  version: string
  containerId: string
  containment: 'processcontainer'
  lifecycle: { destroyOnExit: true; preservePolicy: false }
  process: { commandLine: string; cwd: string; env: string[] }
  filesystem: {
    readwritePaths: string[]
    readonlyPaths: string[]
    deniedPaths: string[]
    clearPolicyOnExit: true
  }
  network: {
    enforcementMode: 'capabilities'
    defaultPolicy: 'allow' | 'block'
    allowLocalNetwork: boolean
  }
  processContainer: {
    leastPrivilege: false
    capabilities: string[]
    ui: {
      isolation: 'container'
      desktopSystemControl: false
      systemSettings: 'none'
      ime: false
    }
  }
  ui: { disable: true; clipboard: 'none'; injection: false }
}

export interface WindowsSandboxResolution {
  executable?: string
  reason?: string
}

export interface WindowsSandboxProbe {
  supported: boolean
  tier?: 'base-container' | 'appcontainer-bfs' | 'appcontainer-dacl'
  reason?: string
}

interface ProbeResult {
  status: number | null
  stdout?: string | Buffer
  stderr?: string | Buffer
  error?: Error
}

const probeCache = new Map<string, WindowsSandboxProbe>()

function sdkRoot(): string | undefined {
  try {
    const require = createRequire(import.meta.url)
    return dirname(require.resolve(`${WINDOWS_SANDBOX_PACKAGE}/package.json`))
  } catch {
    return undefined
  }
}

function sdkArchitecture(value: string): 'x64' | 'arm64' | undefined {
  if (value === 'x64' || value === 'arm64') return value
  return undefined
}

/** Menemukan executor yang dibawa paket resmi MXC dan dikunci di lockfile. */
export function resolveWindowsSandboxExecutable(
  environment: NodeJS.ProcessEnv = process.env,
  architecture: string = arch(),
  exists: (path: string) => boolean = existsSync,
  packageRoot: string | undefined = sdkRoot(),
): WindowsSandboxResolution {
  const target = sdkArchitecture(architecture)
  if (!target) return { reason: `arsitektur Windows ${architecture} belum didukung MXC` }

  const candidates = [
    ...(environment.MXC_BIN_DIR ? [join(environment.MXC_BIN_DIR, target, 'wxc-exec.exe')] : []),
    ...(packageRoot ? [join(packageRoot, 'bin', target, 'wxc-exec.exe')] : []),
  ]
  const executable = candidates.find((candidate) => !candidate.includes('.asar') && exists(candidate))
  if (executable) return { executable }
  return { reason: `${WINDOWS_SANDBOX_PACKAGE} tidak memuat wxc-exec.exe untuk ${target}` }
}

function distinctWindowsPaths(paths: readonly string[], exists: (path: string) => boolean): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of paths) {
    const path = raw.trim().replace(/^"|"$/g, '')
    if (!path || path.includes('\0') || !win32.isAbsolute(path) || !exists(path)) continue
    const key = win32.normalize(path).toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(path)
  }
  return result
}

/** Path tool host diberi baca saja; profile pengguna tidak pernah dibuka luas. */
export function windowsToolPaths(
  shell: Shell,
  environment: NodeJS.ProcessEnv,
  executable = process.execPath,
  exists: (path: string) => boolean = existsSync,
): string[] {
  const pathEntries = (environment.Path ?? environment.PATH ?? '').split(';')
  const wellKnown = ['JAVA_HOME', 'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'GOROOT', 'DOTNET_ROOT', 'PYTHONHOME']
    .map((key) => environment[key] ?? '')
  return distinctWindowsPaths([
    win32.dirname(executable),
    ...(win32.isAbsolute(shell.file) ? [win32.dirname(shell.file)] : []),
    ...pathEntries,
    ...wellKnown,
  ], exists)
}

/** Quoting CreateProcess/CommandLineToArgvW, bukan escaping shell. */
export function quoteWindowsArgument(value: string): string {
  if (value && !/[\s"]/.test(value)) return value
  let quoted = '"'
  let slashes = 0
  for (const character of value) {
    if (character === '\\') {
      slashes += 1
      continue
    }
    if (character === '"') {
      quoted += '\\'.repeat(slashes * 2 + 1) + '"'
      slashes = 0
      continue
    }
    quoted += '\\'.repeat(slashes) + character
    slashes = 0
  }
  return quoted + '\\'.repeat(slashes * 2) + '"'
}

export function windowsCommandLine(shell: Shell, command: string): string {
  const executable = quoteWindowsArgument(shell.file)
  // cmd.exe tidak memakai CommandLineToArgvW. Argumen /c dari resolveShell sudah
  // memiliki pasangan quote luar yang harus diteruskan verbatim.
  if (shell.name.toLowerCase() === 'cmd') return [executable, ...shell.args(command)].join(' ')
  return [executable, ...shell.args(command).map(quoteWindowsArgument)].join(' ')
}

/** Probe native di-cache; kegagalan tidak pernah dilaporkan sebagai enforced. */
export function probeWindowsSandbox(
  executable: string,
  run?: (file: string, args: string[]) => ProbeResult,
  cached = run === undefined,
): WindowsSandboxProbe {
  if (cached) {
    const existing = probeCache.get(executable)
    if (existing) return existing
  }
  const runner = run ?? ((file: string, args: string[]) => spawnSync(file, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5_000,
    windowsHide: true,
  }))
  const result = runner(executable, ['--probe'])
  let probe: WindowsSandboxProbe
  try {
    const parsed = JSON.parse(String(result.stdout ?? '')) as { tier?: unknown }
    const tier = parsed.tier
    const validTier = tier === 'base-container' || tier === 'appcontainer-bfs' || tier === 'appcontainer-dacl'
    probe = result.status === 0 && validTier
      ? { supported: true, tier }
      : { supported: false, reason: String(result.stderr ?? result.error?.message ?? 'probe MXC tidak mengembalikan isolation tier').trim() }
  } catch {
    probe = { supported: false, reason: String(result.stderr ?? result.error?.message ?? 'keluaran probe MXC tidak sah').trim() }
  }
  if (cached) probeCache.set(executable, probe)
  return probe
}

function sanitizedEnvironment(environment: NodeJS.ProcessEnv, temporary: string): string[] {
  const merged = { ...environment, TEMP: temporary, TMP: temporary, TERM: 'dumb', NO_COLOR: '1', FORCE_COLOR: '0' }
  return Object.entries(merged)
    .filter(([key, value]) => Boolean(key) && !key.includes('=') && !key.includes('\0') && value !== undefined && !value.includes('\0'))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
}

export function windowsSandboxTemporaryDirectory(base = tmpdir()): string {
  return join(base, WINDOWS_SANDBOX_TEMP_DIRECTORY)
}

export function windowsSandboxConfig(
  shell: Shell,
  command: string,
  workspace: string,
  policy: SandboxPolicy,
  environment: NodeJS.ProcessEnv,
  temporary: string,
  exists: (path: string) => boolean = existsSync,
  protectedDirectories: readonly string[] = ['.git', '.boo', '.codex', '.agents'],
): WindowsSandboxConfig {
  const root = win32.normalize(workspace)
  const protectedPaths = protectedDirectories
    .map((name) => win32.join(root, name))
    .filter(exists)
  const tools = windowsToolPaths(shell, environment, process.execPath, exists)
    .filter((path) => !path.toLowerCase().startsWith(`${root.toLowerCase()}\\`))
  const writable = policy.mode === 'workspace-write' ? [root, temporary] : [temporary]
  const readonly = policy.mode === 'read-only' ? [root, ...tools] : tools
  const network = Boolean(policy.networkAccess)

  return {
    version: WINDOWS_SANDBOX_SCHEMA_VERSION,
    containerId: `boo-${randomUUID()}`,
    containment: 'processcontainer',
    lifecycle: { destroyOnExit: true, preservePolicy: false },
    process: {
      commandLine: windowsCommandLine(shell, command),
      cwd: root,
      env: sanitizedEnvironment(environment, temporary),
    },
    filesystem: {
      readwritePaths: writable,
      readonlyPaths: readonly,
      deniedPaths: protectedPaths,
      clearPolicyOnExit: true,
    },
    network: {
      enforcementMode: 'capabilities',
      defaultPolicy: network ? 'allow' : 'block',
      allowLocalNetwork: network,
    },
    processContainer: {
      leastPrivilege: false,
      capabilities: network ? ['internetClient', 'privateNetworkClientServer'] : [],
      ui: {
        isolation: 'container',
        desktopSystemControl: false,
        systemSettings: 'none',
        ime: false,
      },
    },
    ui: { disable: true, clipboard: 'none', injection: false },
  }
}

export function encodeWindowsSandboxConfig(config: WindowsSandboxConfig): string {
  return Buffer.from(JSON.stringify(config), 'utf8').toString('base64')
}

/** Membuat temp privat Boo. MXC menambahkan dan membersihkan ACL AppContainer. */
export function ensureWindowsSandboxTemporaryDirectory(path = windowsSandboxTemporaryDirectory()): string {
  mkdirSync(path, { recursive: true })
  return path
}

export function windowsSandboxModeDescription(mode: SandboxMode): string {
  return mode === 'workspace-write' ? 'workspace read/write' : 'workspace read-only'
}
