/** Delegasi paralel kepada sub-agent baca-saja atau penulis yang terisolasi. */

import type { DelegatedResult, DelegatedTask, Tool } from '../domain/tool.ts'
import { gitBlameTool, gitChangedFilesTool, gitDiffTool, gitLogTool, gitShowTool, gitStatusTool } from './git.ts'
import { globTool } from './glob.ts'
import { grepTool } from './grep.ts'
import { listDirTool } from './listDir.ts'
import { listMcpServersTool } from './mcp.ts'
import { readFileTool } from './readFile.ts'
import { readToolOutputTool } from './toolOutput.ts'
import { repoMapTool } from './repoMap.ts'
import { listSkillsTool, readSkillResourceTool, readSkillTool } from './skills.ts'
import { codeGraphTool, codeSearchTool } from './codeSearch.ts'
import { testImpactTool } from './testImpact.ts'
import { memoryListTool } from './memory.ts'
import { writeFileTool } from './writeFile.ts'
import { editFileTool } from './editFile.ts'
import { applyPatchTool } from './applyPatch.ts'
import { todoWriteTool } from './todo.ts'
import { createDiscoverableRegistry, DEFAULT_CORE_TOOL_NAMES } from './toolSearch.ts'

export const MAX_DELEGATED_TASKS = 3
export const DEFAULT_SUBAGENT_TURNS = 8
export const MAX_SUBAGENT_TURNS = 12
const MAX_TASK_CHARACTERS = 4_000

export const SUBAGENT_SYSTEM_PROMPT = `You are a read-only Boo sub-agent working for a primary coding agent.

Investigate only the assigned task. Use the available read-only tools to inspect
the workspace instead of guessing. Return a concise evidence-based report with
relevant file paths and line numbers. Do not propose unrelated work.

You cannot edit files, execute arbitrary commands, call external services, or
delegate again. The primary agent owns all decisions and implementation. Answer
in the language used by the assigned task. If a specialized read-only capability
is absent from the current tool list, find it with tool_search first.`

export const WRITABLE_SUBAGENT_SYSTEM_PROMPT = `You are a Boo implementation sub-agent working for a primary coding agent in an isolated Git worktree.

Implement only the assigned task. Inspect the repository before editing, preserve
existing conventions and user changes, and keep the change focused. You may edit
files with the provided file tools, but you cannot run arbitrary commands, access
external services, open applications, send messages, or delegate again. Do not
edit secrets or agent metadata. The primary agent will merge conflict-free files
and run final verification. If a specialized read-only capability is absent from
the current tool list, find it with tool_search first.

Finish with a concise report listing what you changed and any verification the
primary agent still needs to run. Answer in the language used by the assigned task.`

/** Registry sengaja tidak berisi tool tulis, command, aksi eksternal, atau delegate. */
export function createSubagentRegistry() {
  return createDiscoverableRegistry([
    readFileTool,
    readToolOutputTool,
    listDirTool,
    globTool,
    grepTool,
    codeSearchTool,
    codeGraphTool,
    testImpactTool,
    repoMapTool,
    memoryListTool,
    gitStatusTool,
    gitChangedFilesTool,
    gitDiffTool,
    gitLogTool,
    gitShowTool,
    gitBlameTool,
    listSkillsTool,
    readSkillTool,
    readSkillResourceTool,
    listMcpServersTool,
  ] as never, { alwaysAvailable: DEFAULT_CORE_TOOL_NAMES })
}

/** Tool tulis dibatasi ke file API; tidak ada shell atau efek eksternal. */
export function createWritableSubagentRegistry() {
  return createDiscoverableRegistry([
    ...createSubagentRegistry().list(),
    writeFileTool,
    editFileTool,
    applyPatchTool,
    todoWriteTool,
  ] as never, { alwaysAvailable: DEFAULT_CORE_TOOL_NAMES })
}

interface DelegateArgs {
  tasks: DelegatedTask[]
  max_turns?: number
}

function validateTasks(value: unknown): DelegatedTask[] | string {
  if (!Array.isArray(value) || value.length === 0) return 'tasks wajib berupa array yang tidak kosong.'
  if (value.length > MAX_DELEGATED_TASKS) return `Maksimal ${MAX_DELEGATED_TASKS} task dapat didelegasikan sekaligus.`
  const tasks: DelegatedTask[] = []
  const ids = new Set<string>()
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') return 'Setiap task harus berupa object berisi id dan task.'
    const { id, task } = raw as { id?: unknown; task?: unknown }
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(id)) return 'ID task hanya boleh memakai huruf, angka, _ atau - (maksimal 32 karakter).'
    if (ids.has(id)) return `ID task "${id}" duplikat.`
    if (typeof task !== 'string' || !task.trim()) return `Task "${id}" tidak memiliki instruksi.`
    if (task.length > MAX_TASK_CHARACTERS) return `Instruksi task "${id}" melebihi ${MAX_TASK_CHARACTERS} karakter.`
    ids.add(id)
    tasks.push({ id, task: task.trim() })
  }
  return tasks
}

function resultText(result: DelegatedResult): string {
  const details = [
    `## ${result.id} [${result.status}]`,
    `turns: ${result.turns} · tool calls: ${result.toolCalls}`,
  ]
  if (result.changedFiles?.length) details.push(`merged: ${result.changedFiles.join(', ')}`)
  if (result.conflicts?.length) details.push(`conflicts: ${result.conflicts.join(', ')}`)
  details.push('', result.content.trim() || '(Sub-agent tidak mengembalikan laporan.)')
  return details.join('\n')
}

export const delegateTool: Tool<DelegateArgs> = {
  name: 'delegate',
  description: 'Run up to three independent read-only sub-agents in parallel and return their reports.',
  risk: 'safe',
  schema: {
    type: 'function',
    function: {
      name: 'delegate',
      description: 'Delegate independent repository investigations to isolated read-only sub-agents. Use only when parallel exploration materially helps.',
      parameters: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_DELEGATED_TASKS,
            items: {
              type: 'object',
              properties: { id: { type: 'string' }, task: { type: 'string' } },
              required: ['id', 'task'],
              additionalProperties: false,
            },
          },
          max_turns: { type: 'integer', minimum: 2, maximum: MAX_SUBAGENT_TURNS },
        },
        required: ['tasks'],
      },
    },
  },
  preview: (args) => `delegasikan ${Array.isArray(args.tasks) ? args.tasks.length : 0} investigasi`,
  async run(args, context) {
    const tasks = validateTasks(args.tasks)
    if (typeof tasks === 'string') return { content: `Gagal: ${tasks}`, isError: true }
    if (!context.delegate) return { content: 'Gagal: runner sub-agent tidak tersedia.', isError: true }
    const requested = typeof args.max_turns === 'number' && Number.isFinite(args.max_turns) ? Math.round(args.max_turns) : DEFAULT_SUBAGENT_TURNS
    const maxTurns = Math.max(2, Math.min(MAX_SUBAGENT_TURNS, requested))
    context.onOutput?.(`Menjalankan ${tasks.length} sub-agent baca-saja secara paralel…\n`)
    const results = await Promise.all(tasks.map((task) => context.delegate?.(task, maxTurns)))
    const complete = results.filter((result): result is DelegatedResult => Boolean(result))
    const failed = complete.some((result) => result.status !== 'completed')
    return { content: complete.map(resultText).join('\n\n'), ...(failed ? { isError: true } : {}) }
  },
}

export const delegateWriteTool: Tool<DelegateArgs> = {
  name: 'delegate_write',
  description: 'Run up to three implementation sub-agents in isolated Git worktrees, then merge only conflict-free file changes.',
  risk: 'confirm',
  allowAlways: false,
  writesWorkspace: true,
  mutatesWorkspace: true,
  schema: {
    type: 'function',
    function: {
      name: 'delegate_write',
      description: 'Delegate independent implementation tasks to isolated writable Git worktrees. Each invocation requires fresh user approval.',
      parameters: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_DELEGATED_TASKS,
            items: {
              type: 'object',
              properties: { id: { type: 'string' }, task: { type: 'string' } },
              required: ['id', 'task'],
              additionalProperties: false,
            },
          },
          max_turns: { type: 'integer', minimum: 2, maximum: MAX_SUBAGENT_TURNS },
        },
        required: ['tasks'],
      },
    },
  },
  preview: (args) => `jalankan ${Array.isArray(args.tasks) ? args.tasks.length : 0} sub-agent penulis di worktree terisolasi`,
  async run(args, context) {
    const tasks = validateTasks(args.tasks)
    if (typeof tasks === 'string') return { content: `Gagal: ${tasks}`, isError: true }
    if (!context.delegateWrite) return { content: 'Gagal: runner sub-agent worktree tidak tersedia.', isError: true }
    const requested = typeof args.max_turns === 'number' && Number.isFinite(args.max_turns) ? Math.round(args.max_turns) : DEFAULT_SUBAGENT_TURNS
    const maxTurns = Math.max(2, Math.min(MAX_SUBAGENT_TURNS, requested))
    context.onOutput?.(`Menyiapkan ${tasks.length} Git worktree terisolasi…\n`)
    const results = await context.delegateWrite(tasks, maxTurns)
    const failed = results.some((result) => result.status !== 'completed')
    const merged = results.some((result) => Boolean(result.changedFiles?.length))
    return { content: results.map(resultText).join('\n\n'), ...(failed && !merged ? { isError: true } : {}) }
  },
}
