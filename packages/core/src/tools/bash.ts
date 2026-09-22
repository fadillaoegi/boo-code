import type { Tool } from '../domain/tool.ts'
import { backgroundProcesses } from './background.ts'
import { resolveShell, runCommand } from './shell.ts'
import { inspectSandbox } from './sandbox.ts'

export const DEFAULT_TIMEOUT_SECONDS = 120
export const MAX_TIMEOUT_SECONDS = 600

interface Args {
  command: string
  description?: string
  timeout?: number
  run_in_background?: boolean
  interactive?: boolean
}

const shell = resolveShell()

const DESCRIPTION = `Run a shell command (${shell.name}) in the workspace directory. Use for builds, tests, git, and package managers.
- Commands run in an OS sandbox by default: workspace writes are allowed, agent metadata is read-only, network is blocked, and credential environment variables are removed.
- If the OS sandbox backend is unavailable, the result says so explicitly; user approval is still required.
- Commands time out after ${DEFAULT_TIMEOUT_SECONDS} seconds unless you set timeout (max ${MAX_TIMEOUT_SECONDS}).
- Standard input is closed by default: pass non-interactive flags (for example --yes) instead of expecting prompts.
- For commands that never finish on their own — dev servers, watchers — set run_in_background. You get an id at once; check it with bash_output and stop it with bash_kill.
- If a background command genuinely needs later stdin, also set interactive. Then use bash_input; each input requires fresh user approval. This is a pipe, not a full terminal/TTY.
- Very long output keeps its beginning and end; the middle is skipped.`

/** Batas waktu dari argumen model, dibulatkan ke rentang yang diizinkan. */
export function timeoutSeconds(requested: unknown): number {
  const value = typeof requested === 'number' && Number.isFinite(requested) ? requested : DEFAULT_TIMEOUT_SECONDS
  return Math.min(MAX_TIMEOUT_SECONDS, Math.max(1, Math.round(value)))
}

export const bashTool: Tool<Args> = {
  name: 'bash',
  description: DESCRIPTION,
  risk: 'confirm',
  runsCommand: true,
  schema: {
    type: 'function',
    function: {
      name: 'bash',
      description: DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to run' },
          description: { type: 'string', description: 'Short description of what the command does' },
          timeout: { type: 'number', description: `Timeout in seconds (default ${DEFAULT_TIMEOUT_SECONDS}, max ${MAX_TIMEOUT_SECONDS})` },
          run_in_background: { type: 'boolean', description: 'Start the command and return immediately with an id' },
          interactive: { type: 'boolean', description: 'Keep stdin open for bash_input; only valid with run_in_background' },
        },
        required: ['command'],
      },
    },
  },
  preview: (args) => args.command,
  async run(args, context) {
    const sandbox = context.sandbox ?? { mode: 'workspace-write' as const }
    if (args.interactive && !args.run_in_background) {
      return { content: 'Gagal: interactive hanya berlaku bersama run_in_background.', isError: true }
    }
    if (args.run_in_background) {
      const id = backgroundProcesses.start(args.command, context.workspace, shell, sandbox, args.interactive === true)
      const status = inspectSandbox(context.workspace, sandbox)
      const warning = status.enforced ? '' : ` Peringatan: ${status.reason}`
      const input = args.interactive ? ' Kirim input dengan bash_input; setiap input memerlukan persetujuan baru.' : ''
      return { content: `Berjalan di latar belakang dengan id ${id}. Periksa keluarannya dengan bash_output, hentikan dengan bash_kill.${input}${warning}` }
    }

    const seconds = timeoutSeconds(args.timeout)
    const result = await runCommand(args.command, {
      cwd: context.workspace,
      shell,
      sandbox,
      timeoutMs: seconds * 1_000,
      ...(context.signal ? { signal: context.signal } : {}),
      ...(context.onOutput ? { onOutput: context.onOutput } : {}),
    })
    const warning = result.sandbox.enforced || sandbox.mode === 'danger-full-access' ? '' : `Peringatan sandbox: ${result.sandbox.reason}\n`
    const output = result.output

    if (result.cancelled) {
      return { content: warning + withOutput('Dibatalkan: perintah dihentikan oleh pengguna sebelum selesai.', output), isError: true }
    }
    if (result.spawnError) {
      return { content: `${warning}Gagal menjalankan ${shell.file}: ${result.spawnError}`, isError: true }
    }
    if (result.timedOut) {
      return {
        content: warning + withOutput(
          `Waktu habis: perintah dihentikan setelah ${seconds} detik. Naikkan timeout bila memang lama, atau jalankan dengan run_in_background bila perintah ini tidak pernah selesai sendiri.`,
          output,
        ),
        isError: true,
      }
    }
    if (result.exitCode !== 0) {
      return { content: `${warning}Perintah gagal (exit ${result.exitCode ?? '?'}):\n${output || '(tanpa keluaran)'}`, isError: true }
    }
    return { content: warning + (output || '(tanpa keluaran)') }
  },
}

function withOutput(message: string, output: string): string {
  return output ? `${message}\nKeluaran sejauh ini:\n${output}` : message
}
