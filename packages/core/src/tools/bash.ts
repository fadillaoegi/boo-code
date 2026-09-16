import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Tool } from '../domain/tool.ts'

const run = promisify(execFile)
const TIMEOUT_MS = 120_000
const MAX_OUTPUT = 30_000

interface Args { command: string; description?: string }

export const bashTool: Tool<Args> = {
  name: 'bash',
  description: 'Run a shell command in the workspace directory. Use for builds, tests, and git.',
  risk: 'confirm',
  schema: {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Run a shell command in the workspace directory. Use for builds, tests, and git.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to run' },
          description: { type: 'string', description: 'Short description of what the command does' },
        },
        required: ['command'],
      },
    },
  },
  preview: (args) => args.command,
  async run(args, context) {
    try {
      const { stdout, stderr } = await run('/bin/zsh', ['-c', args.command], {
        cwd: context.workspace,
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT * 4,
      })
      const output = [stdout, stderr].filter(Boolean).join('\n').trim()
      return { content: output.slice(0, MAX_OUTPUT) || '(tanpa keluaran)' }
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; message?: string; code?: number }
      const output = [failure.stdout, failure.stderr].filter(Boolean).join('\n').trim()
      return {
        content: `Perintah gagal (exit ${failure.code ?? '?'}):\n${output || failure.message}`.slice(0, MAX_OUTPUT),
        isError: true,
      }
    }
  },
}
