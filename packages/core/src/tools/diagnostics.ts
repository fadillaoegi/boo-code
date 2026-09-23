import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Tool, ToolRecovery } from '../domain/tool.ts'
import { adaptiveTimeoutProfile, rememberAdaptiveTimeout, selectAdaptiveTimeout } from './adaptiveTimeout.ts'
import { runCommand } from './shell.ts'

export type DiagnosticKind = 'types' | 'lint'
export interface DiagnosticCommand { kind: DiagnosticKind; label: string; command: string }

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function text(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return ''
  }
}

function packageRunner(files: Set<string>): string {
  if (files.has('pnpm-lock.yaml')) return 'pnpm run'
  if (files.has('yarn.lock')) return 'yarn run'
  if (files.has('bun.lock') || files.has('bun.lockb')) return 'bun run'
  return 'npm run'
}

function wants(requested: 'all' | DiagnosticKind | undefined, kind: DiagnosticKind): boolean {
  return !requested || requested === 'all' || requested === kind
}

/** Menemukan pemeriksaan statis yang memang dikonfigurasi proyek, tanpa menebak command dari prompt. */
export async function detectProjectDiagnostics(workspace: string, requested?: 'all' | DiagnosticKind): Promise<DiagnosticCommand[]> {
  const rootNames = ['package.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'tsconfig.json', 'go.mod', 'Cargo.toml', 'pubspec.yaml', 'pyproject.toml']
  const present = new Set<string>()
  for (const name of rootNames) if (await exists(join(workspace, name))) present.add(name)
  const commands: DiagnosticCommand[] = []

  if (present.has('package.json')) {
    let scripts: Record<string, unknown> = {}
    try {
      const manifest = JSON.parse(await text(join(workspace, 'package.json'))) as { scripts?: Record<string, unknown> }
      scripts = manifest.scripts ?? {}
    } catch {
      // Manifest rusak akan dilaporkan compiler/package manager bila command lain ada.
    }
    const runner = packageRunner(present)
    if (wants(requested, 'types')) {
      const name = ['typecheck', 'check:types', 'check'].find((candidate) => typeof scripts[candidate] === 'string')
      if (name) commands.push({ kind: 'types', label: `Type diagnostics (${name})`, command: `${runner} ${name}` })
      else if (present.has('tsconfig.json') && await exists(join(workspace, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc'))) {
        const binary = process.platform === 'win32' ? '.\\node_modules\\.bin\\tsc.cmd' : './node_modules/.bin/tsc'
        commands.push({ kind: 'types', label: 'TypeScript diagnostics', command: `${binary} --noEmit --pretty false` })
      }
    }
    if (wants(requested, 'lint') && typeof scripts.lint === 'string') {
      commands.push({ kind: 'lint', label: 'Lint diagnostics', command: `${runner} lint` })
    }
  }

  if (wants(requested, 'types') && present.has('go.mod')) commands.push({ kind: 'types', label: 'Go diagnostics', command: 'go vet ./...' })
  if (wants(requested, 'types') && present.has('Cargo.toml')) commands.push({ kind: 'types', label: 'Rust diagnostics', command: 'cargo check --all-targets --message-format short' })
  if (wants(requested, 'types') && present.has('pubspec.yaml')) {
    const pubspec = await text(join(workspace, 'pubspec.yaml'))
    commands.push({ kind: 'types', label: 'Dart diagnostics', command: /^\s*flutter\s*:/m.test(pubspec) ? 'flutter analyze --no-pub' : 'dart analyze' })
  }
  if (present.has('pyproject.toml')) {
    const pyproject = await text(join(workspace, 'pyproject.toml'))
    const pyright = process.platform === 'win32'
      ? join(workspace, 'node_modules', '.bin', 'pyright.cmd')
      : join(workspace, 'node_modules', '.bin', 'pyright')
    if (wants(requested, 'types') && await exists(pyright)) {
      commands.push({ kind: 'types', label: 'Python type diagnostics', command: process.platform === 'win32' ? '.\\node_modules\\.bin\\pyright.cmd' : './node_modules/.bin/pyright' })
    }
    if (wants(requested, 'lint') && /\[tool\.ruff(?:\.|\])/m.test(pyproject)) {
      const ruff = process.platform === 'win32' ? '.\\.venv\\Scripts\\ruff.exe' : './.venv/bin/ruff'
      if (await exists(join(workspace, ...ruff.replace(/^\.\//, '').split(/[\\/]/)))) {
        commands.push({ kind: 'lint', label: 'Python lint diagnostics', command: `${ruff} check .` })
      }
    }
  }

  return commands.filter((entry, index) => commands.findIndex((other) => other.command === entry.command) === index)
}

interface DiagnosticsArgs { kind?: 'all' | DiagnosticKind; timeout?: number }

export const diagnosticsTool: Tool<DiagnosticsArgs> = {
  name: 'diagnostics',
  description: 'Detect and run project-configured static diagnostics (typecheck/check/lint) without inventing a command. Runs with approval inside the command sandbox and counts as completion verification when all checks pass.',
  risk: 'confirm',
  writesWorkspace: true,
  runsCommand: true,
  verifiesWorkspace: true,
  schema: {
    type: 'function',
    function: {
      name: 'diagnostics',
      description: 'Run detected static diagnostics for the project.',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['all', 'types', 'lint'], description: 'Diagnostics to run; defaults to all' },
          timeout: { type: 'number', description: 'Exact hard timeout per command in seconds, 1–600; omit for adaptive timeout' },
        },
      },
    },
  },
  preview: (args) => `jalankan diagnostics ${args.kind ?? 'types + lint'}`,
  async detail(args, context) {
    const commands = await detectProjectDiagnostics(context.workspace, args.kind)
    return commands.length ? commands.map((entry) => ({ kind: 'context' as const, text: `$ ${entry.command}` })) : null
  },
  async run(args, context) {
    const commands = await detectProjectDiagnostics(context.workspace, args.kind)
    if (!commands.length) return { content: 'Gagal: tidak menemukan konfigurasi diagnostics yang didukung di root workspace.', isError: true }
    const sections: string[] = []
    let failed = false
    let recovery: ToolRecovery | undefined
    for (const entry of commands) {
      context.onOutput?.(`\n[${entry.label}] ${entry.command}\n`)
      const timeout = selectAdaptiveTimeout(entry.command, args.timeout, adaptiveTimeoutProfile(context.home))
      const result = await runCommand(entry.command, {
        cwd: context.workspace,
        timeoutMs: timeout.idleSeconds * 1_000,
        ...(timeout.mode === 'adaptive' ? { maxRuntimeMs: timeout.maximumSeconds * 1_000 } : {}),
        sandbox: context.sandbox,
        ...(context.signal ? { signal: context.signal } : {}),
        ...(context.onOutput ? { onOutput: context.onOutput } : {}),
      })
      const updatedProfile = !result.cancelled && !result.spawnError
        ? rememberAdaptiveTimeout(context.home, timeout.category, result.durationMs, result.timedOut)
        : undefined
      const warning = result.sandbox.enforced || context.sandbox?.mode === 'danger-full-access' ? '' : `\nPeringatan sandbox: ${result.sandbox.reason}`
      const state = result.cancelled ? 'dibatalkan' : result.timedOut ? 'waktu habis' : result.spawnError ? `gagal dimulai: ${result.spawnError}` : `exit ${result.exitCode ?? '?'}`
      const timeoutNote = result.timedOut
        ? `\n[recovery: ${result.timeoutReason === 'idle' ? 'tanpa progres' : 'hard cap'}; periksa state sebelum mengulang]`
        : ''
      sections.push(`## ${entry.label}\n$ ${entry.command}\n${result.output || '(tanpa keluaran)'}\n[${state}]${timeoutNote}${warning}`)
      if (result.timedOut) {
        const next = selectAdaptiveTimeout(entry.command, undefined, updatedProfile ?? adaptiveTimeoutProfile(context.home))
        recovery = {
          kind: 'timeout',
          reason: result.timeoutReason ?? 'maximum',
          category: timeout.category,
          durationMs: result.durationMs,
          idleTimeoutMs: timeout.idleSeconds * 1_000,
          maximumTimeoutMs: timeout.maximumSeconds * 1_000,
          nextIdleTimeoutMs: next.idleSeconds * 1_000,
          partialOutput: Boolean(result.output),
        }
      }
      if (result.cancelled || result.timedOut || result.spawnError || result.exitCode !== 0) failed = true
      if (result.cancelled) break
    }
    return { content: sections.join('\n\n'), ...(failed ? { isError: true } : {}), ...(recovery ? { recovery } : {}) }
  },
}
