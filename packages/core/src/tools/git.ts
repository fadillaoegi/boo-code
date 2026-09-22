import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Tool } from '../domain/tool.ts'
import { isSensitivePath, sensitiveRefusal } from './secrets.ts'
import { resolveInWorkspace } from './workspace.ts'
import { commandEnvironment } from './shell.ts'
import { isProtectedWorkspacePath } from './sandbox.ts'

const execFileAsync = promisify(execFile)
const MAX_OUTPUT = 60_000
export const MAX_COMMIT_PATHS = 50
export const MAX_COMMIT_MESSAGE_CHARACTERS = 4_000
export const MAX_GIT_LOG_COMMITS = 50
export const MAX_GIT_BLAME_LINES = 200

async function git(args: string[], workspace: string, signal?: AbortSignal, preserve = false): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd: workspace,
      env: { ...commandEnvironment(), GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', GIT_LITERAL_PATHSPECS: '1' },
      encoding: 'utf8',
      maxBuffer: 1_000_000,
      timeout: 15_000,
      signal,
    })
    const combined = `${stdout}${stderr}`
    const output = preserve ? combined : combined.trim()
    if (preserve) return output
    return output.length > MAX_OUTPUT
      ? `${output.slice(0, MAX_OUTPUT)}\n[… output dipotong; gunakan path yang lebih spesifik …]`
      : output
  } catch (error) {
    const detail = error as Error & { stderr?: string; code?: string | number }
    const message = detail.stderr?.trim() || detail.message
    throw new Error(message.includes('not a git repository') ? 'Workspace ini bukan repository Git.' : message, { cause: error })
  }
}

/** Operasi Git terkontrol yang boleh menulis index/ref, tanpa shell atau prompt. */
async function gitWrite(args: string[], workspace: string): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd: workspace,
      env: {
        ...commandEnvironment(),
        GIT_OPTIONAL_LOCKS: '0',
        GIT_PAGER: 'cat',
        GIT_LITERAL_PATHSPECS: '1',
        GIT_EDITOR: 'true',
        GIT_TERMINAL_PROMPT: '0',
      },
      encoding: 'utf8',
      maxBuffer: 1_000_000,
      timeout: 120_000,
    })
    return `${stdout}${stderr}`.trim()
  } catch (error) {
    const detail = error as Error & { stderr?: string; stdout?: string }
    const message = detail.stderr?.trim() || detail.stdout?.trim() || detail.message
    throw new Error(message.includes('not a git repository') ? 'Workspace ini bukan repository Git.' : message, { cause: error })
  }
}

export const gitStatusTool: Tool<Record<string, never>> = {
  name: 'git_status',
  description: 'Show the current Git branch and changed/untracked files. Read-only; use it before editing an existing repository so user changes are preserved.',
  risk: 'safe',
  parallelSafe: true,
  schema: {
    type: 'function',
    function: {
      name: 'git_status',
      description: 'Show the current Git branch and changed/untracked files. Read-only.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  preview: () => 'periksa status Git',
  async run(_args, context) {
    try {
      const output = await git(['-c', 'core.fsmonitor=false', 'status', '--short', '--branch', '--untracked-files=normal'], context.workspace, context.signal)
      return { content: output || 'Working tree bersih.' }
    } catch (error) {
      return { content: `Gagal: ${error instanceof Error ? error.message : 'git status gagal'}`, isError: true }
    }
  },
}

function revision(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return /^[A-Za-z0-9][A-Za-z0-9._/~^-]{0,127}$/.test(trimmed) && !trimmed.includes('..') ? trimmed : null
}

function cleanGitHistoryText(value: string): string {
  return Array.from(value, (character) => {
    const code = character.charCodeAt(0)
    if (character === '\n' || character === '\t') return character
    if (character === '\r') return ''
    return code < 0x20 || code === 0x7f ? `\\u${code.toString(16).padStart(4, '0')}` : character
  }).join('')
}

function gitPath(value: string, workspace: string): string | null {
  if (!value.trim() || value.length > 4_096 || isSensitivePath(value)) return null
  try {
    const absolute = resolveInWorkspace(workspace, value)
    const path = relative(resolve(workspace), absolute).split(sep).join('/')
    return path && path !== '.' ? path : null
  } catch {
    return null
  }
}

interface ChangedFilesArgs { base?: string; staged?: boolean }

export const gitChangedFilesTool: Tool<ChangedFilesArgs> = {
  name: 'git_changed_files',
  description: 'List changed files for the working tree or current branch versus a trusted base revision, without returning file contents.',
  risk: 'safe',
  parallelSafe: true,
  schema: {
    type: 'function',
    function: {
      name: 'git_changed_files',
      description: 'List changed paths and statuses. Pass base to compare base...HEAD; otherwise list staged or unstaged tracked changes.',
      parameters: {
        type: 'object',
        properties: {
          base: { type: 'string', description: 'Trusted branch or revision such as main or origin/main' },
          staged: { type: 'boolean', description: 'Without base, list staged instead of unstaged changes' },
        },
      },
    },
  },
  preview: (args) => args.base ? `daftar perubahan sejak ${args.base}` : `daftar perubahan Git${args.staged ? ' staged' : ''}`,
  async run(args, context) {
    const base = args.base === undefined ? null : revision(args.base)
    if (args.base !== undefined && !base) return { content: 'Gagal: base Git tidak valid.', isError: true }
    const command = ['diff', '--name-status', '--no-renames']
    if (base) command.push(`${base}...HEAD`)
    else if (args.staged === true) command.push('--cached')
    try {
      const output = await git(command, context.workspace, context.signal)
      const safe = output.split('\n').filter(Boolean).map((line) => {
        const path = line.split('\t').at(-1) ?? ''
        return isSensitivePath(path) ? `${line.split('\t')[0]}\t[sensitive file omitted]` : line
      }).join('\n')
      return { content: safe || 'Tidak ada file berubah pada perbandingan ini.' }
    } catch (error) {
      return { content: `Gagal: ${error instanceof Error ? error.message : 'git diff gagal'}`, isError: true }
    }
  },
}

interface DiffArgs { path: string; staged?: boolean; base?: string }

export const gitDiffTool: Tool<DiffArgs> = {
  name: 'git_diff',
  description: 'Show the read-only Git diff for one file. Use it to inspect and preserve pre-existing user changes before editing that file.',
  risk: 'safe',
  parallelSafe: true,
  schema: {
    type: 'function',
    function: {
      name: 'git_diff',
      description: 'Show the Git diff for one workspace file without changing it.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the workspace root' },
          staged: { type: 'boolean', description: 'Show staged diff instead of unstaged diff' },
          base: { type: 'string', description: 'Compare base...HEAD for this file' },
        },
        required: ['path'],
      },
    },
  },
  preview: (args) => `lihat diff ${args.path}`,
  async run(args, context) {
    if (isSensitivePath(args.path)) return { content: sensitiveRefusal(args.path), isError: true }
    const base = args.base === undefined ? null : revision(args.base)
    if (args.base !== undefined && !base) return { content: 'Gagal: base Git tidak valid.', isError: true }
    const absolute = resolveInWorkspace(context.workspace, args.path)
    const path = relative(context.workspace, absolute).split(sep).join('/')
    try {
      const command = ['diff', '--no-ext-diff', '--no-textconv', '--unified=3']
      if (base) command.push(`${base}...HEAD`)
      else if (args.staged === true) command.push('--cached')
      command.push('--', path)
      const output = await git(command, context.workspace, context.signal)
      return { content: output || `Tidak ada diff ${args.staged === true ? 'staged ' : ''}untuk ${path}.` }
    } catch (error) {
      return { content: `Gagal: ${error instanceof Error ? error.message : 'git diff gagal'}`, isError: true }
    }
  },
}

interface LogArgs { ref?: string; path?: string; max_count?: number }

export const gitLogTool: Tool<LogArgs> = {
  name: 'git_log',
  description: 'Read recent Git commit history, optionally limited to one workspace path. Use when history can explain intent, a regression, or ownership; do not call routinely.',
  risk: 'safe',
  parallelSafe: true,
  schema: {
    type: 'function',
    function: {
      name: 'git_log',
      description: 'List recent commits with short hash, date, author name, and subject. Author email and commit bodies are omitted. Optionally filter to one path.',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Branch, tag, hash, or relative revision such as HEAD~3; defaults to HEAD' },
          path: { type: 'string', description: 'Optional file or directory path inside the workspace' },
          max_count: { type: 'integer', minimum: 1, maximum: MAX_GIT_LOG_COMMITS, description: 'Maximum commits; defaults to 20' },
        },
      },
    },
  },
  preview: (args) => `lihat riwayat Git${args.path ? ` ${args.path}` : ''}`,
  async run(args, context) {
    const ref = args.ref === undefined ? 'HEAD' : revision(args.ref)
    if (!ref) return { content: 'Gagal: ref Git tidak valid.', isError: true }
    const path = args.path === undefined ? null : gitPath(args.path, context.workspace)
    if (args.path !== undefined && !path) {
      return { content: isSensitivePath(args.path) ? sensitiveRefusal(args.path) : 'Gagal: path Git tidak valid.', isError: true }
    }
    const count = Number.isInteger(args.max_count) ? Math.min(MAX_GIT_LOG_COMMITS, Math.max(1, args.max_count!)) : 20
    const command = ['log', '--no-decorate', '--date=short', '--pretty=format:%h%x09%ad%x09%an%x09%s', `--max-count=${count}`, ref]
    if (path) command.push('--', path)
    try {
      const output = cleanGitHistoryText(await git(command, context.workspace, context.signal))
      return { content: output || `Tidak ada commit untuk ${path ?? ref}.` }
    } catch (error) {
      return { content: `Gagal: ${error instanceof Error ? error.message : 'git log gagal'}`, isError: true }
    }
  },
}

interface ShowArgs { ref: string; path: string }

export const gitShowTool: Tool<ShowArgs> = {
  name: 'git_show',
  description: 'Show the patch for one non-sensitive workspace file in a specific Git revision. Read-only and bounded; use after git_log identifies a relevant commit.',
  risk: 'safe',
  parallelSafe: true,
  schema: {
    type: 'function',
    function: {
      name: 'git_show',
      description: 'Show commit metadata and the patch for exactly one workspace file at a trusted Git revision.',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Commit, tag, branch, or relative revision such as HEAD~1' },
          path: { type: 'string', description: 'Exact file path inside the workspace' },
        },
        required: ['ref', 'path'],
      },
    },
  },
  preview: (args) => `lihat ${args.path} pada ${args.ref}`,
  async run(args, context) {
    const ref = revision(args.ref)
    if (!ref) return { content: 'Gagal: ref Git tidak valid.', isError: true }
    if (isSensitivePath(args.path)) return { content: sensitiveRefusal(args.path), isError: true }
    const path = gitPath(args.path, context.workspace)
    if (!path) return { content: 'Gagal: path Git tidak valid.', isError: true }
    try {
      const output = cleanGitHistoryText(await git([
        'show', '--no-ext-diff', '--no-textconv', '--no-renames', '--date=iso-strict',
        '--format=format:commit %H%nAuthor: %an%nDate: %aI%nSubject: %s%n', '--unified=3', ref, '--', path,
      ], context.workspace, context.signal))
      return { content: output || `Commit ${ref} tidak mengubah ${path}.` }
    } catch (error) {
      return { content: `Gagal: ${error instanceof Error ? error.message : 'git show gagal'}`, isError: true }
    }
  },
}

interface BlameArgs { path: string; start_line?: number; end_line?: number }

interface BlameState { hash: string; line: number; author: string; date: string; summary: string }

function parseBlame(raw: string): string {
  const output: string[] = []
  let state: BlameState | null = null
  for (const line of raw.split('\n')) {
    const header = /^([0-9a-f^]{7,64}) \d+ (\d+)(?: \d+)?$/.exec(line)
    if (header) {
      state = { hash: header[1].replace(/^\^/, '').slice(0, 10), line: Number(header[2]), author: '?', date: '?', summary: '' }
      continue
    }
    if (!state) continue
    if (line.startsWith('author ')) state.author = line.slice(7, 87)
    else if (line.startsWith('author-time ')) {
      const seconds = Number(line.slice(12))
      if (Number.isFinite(seconds)) state.date = new Date(seconds * 1_000).toISOString().slice(0, 10)
    } else if (line.startsWith('summary ')) state.summary = line.slice(8, 168)
    else if (line.startsWith('\t')) {
      const code = line.slice(1, 501)
      output.push(`${state.line}\t${state.hash}\t${state.date}\t${state.author} · ${state.summary}\t| ${code}`)
      state = null
    }
  }
  return cleanGitHistoryText(output.join('\n'))
}

export const gitBlameTool: Tool<BlameArgs> = {
  name: 'git_blame',
  description: 'Attribute a bounded line range of one non-sensitive file to commits. Use to understand why specific code exists, then inspect a relevant commit with git_show.',
  risk: 'safe',
  parallelSafe: true,
  schema: {
    type: 'function',
    function: {
      name: 'git_blame',
      description: `Show commit, date, author name, subject, and source for at most ${MAX_GIT_BLAME_LINES} lines. Author email is never returned.`,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Exact file path inside the workspace' },
          start_line: { type: 'integer', minimum: 1, description: 'First line, 1-based; defaults to 1' },
          end_line: { type: 'integer', minimum: 1, description: `Last line, inclusive; defaults to at most ${MAX_GIT_BLAME_LINES} lines` },
        },
        required: ['path'],
      },
    },
  },
  preview: (args) => `lihat blame ${args.path}${args.start_line ? `:${args.start_line}${args.end_line ? `-${args.end_line}` : ''}` : ''}`,
  async run(args, context) {
    if (isSensitivePath(args.path)) return { content: sensitiveRefusal(args.path), isError: true }
    const path = gitPath(args.path, context.workspace)
    if (!path) return { content: 'Gagal: path Git tidak valid.', isError: true }
    const start = Number.isInteger(args.start_line) ? args.start_line! : 1
    const end = args.end_line === undefined ? start + MAX_GIT_BLAME_LINES - 1 : args.end_line
    if (!Number.isInteger(end) || end < start) return { content: 'Gagal: end_line harus sama dengan atau lebih besar dari start_line.', isError: true }
    const count = end - start + 1
    if (count > MAX_GIT_BLAME_LINES) return { content: `Gagal: maksimal ${MAX_GIT_BLAME_LINES} baris per git_blame.`, isError: true }
    try {
      const raw = await git(['blame', '--line-porcelain', '-L', `${start},+${count}`, '--', path], context.workspace, context.signal)
      const output = parseBlame(raw)
      return { content: output || `Tidak ada blame untuk ${path}:${start}-${end}.` }
    } catch (error) {
      return { content: `Gagal: ${error instanceof Error ? error.message : 'git blame gagal'}`, isError: true }
    }
  },
}

interface CommitArgs { message: string; paths: string[] }

interface CommitState {
  message: string
  paths: string[]
  fingerprint: string
  error?: string
}

const commitPreviews = new WeakMap<object, CommitState>()

function unsupportedControl(text: string): boolean {
  return [...text].some((character) => {
    const code = character.charCodeAt(0)
    return code === 0x7f || (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d)
  })
}

function commitMessage(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const message = value.trim()
  if (!message || message.length > MAX_COMMIT_MESSAGE_CHARACTERS || unsupportedControl(message)) return null
  return message
}

function porcelainPaths(raw: string): Set<string> {
  const fields = raw.split('\0')
  const paths = new Set<string>()
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]
    if (!field || field.length < 4) continue
    const status = field.slice(0, 2)
    paths.add(field.slice(3).replaceAll('\\', '/'))
    if (/[RC]/.test(status)) {
      const original = fields[index + 1]
      if (original) paths.add(original.replaceAll('\\', '/'))
      index += 1
    }
  }
  return paths
}

function validatedCommitPaths(value: unknown, workspace: string): string[] | string {
  if (!Array.isArray(value) || value.length === 0) return 'paths wajib berupa array yang tidak kosong.'
  if (value.length > MAX_COMMIT_PATHS) return `Maksimal ${MAX_COMMIT_PATHS} path per commit.`
  const paths: string[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'string' || !entry.trim()) return 'Setiap path commit harus berupa teks yang tidak kosong.'
    if (entry.length > 1_024 || unsupportedControl(entry)) return 'Path commit terlalu panjang atau memuat karakter kontrol.'
    let path: string
    try {
      const absolute = resolveInWorkspace(workspace, entry)
      path = relative(resolve(workspace), absolute).split(sep).join('/')
      if (!path || path === '.') return 'Akar workspace tidak dapat dijadikan path commit; sebutkan setiap file.'
      if (existsSync(absolute) && lstatSync(absolute).isDirectory()) return `Path commit harus menunjuk file, bukan direktori: ${path}`
    } catch (error) {
      return error instanceof Error ? error.message : `Path commit tidak sah: ${entry}`
    }
    if (isProtectedWorkspacePath(path)) return `Path metadata internal tidak boleh di-commit oleh Boo: ${path}`
    if (isSensitivePath(path)) return `File credential tidak boleh di-commit oleh Boo: ${path}`
    if (!seen.has(path)) {
      seen.add(path)
      paths.push(path)
    }
  }
  return paths
}

async function commitState(args: CommitArgs, workspace: string): Promise<CommitState> {
  const message = commitMessage(args.message)
  if (!message) {
    return { message: '', paths: [], fingerprint: '', error: `Pesan commit wajib 1–${MAX_COMMIT_MESSAGE_CHARACTERS} karakter tanpa karakter kontrol.` }
  }
  const paths = validatedCommitPaths(args.paths, workspace)
  if (typeof paths === 'string') return { message, paths: [], fingerprint: '', error: paths }
  try {
    const status = await git(['-c', 'core.fsmonitor=false', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...paths], workspace, undefined, true)
    const changed = porcelainPaths(status)
    const unchanged = paths.filter((path) => !changed.has(path))
    if (unchanged.length) {
      return { message, paths, fingerprint: '', error: `Path berikut tidak memiliki perubahan untuk di-commit: ${unchanged.join(', ')}` }
    }
    const head = await git(['rev-parse', '--verify', 'HEAD'], workspace).catch(() => '(unborn)')
    const index = await git(['ls-files', '--stage', '--', ...paths], workspace)
    const worktree: string[] = []
    for (const path of paths) {
      const absolute = resolveInWorkspace(workspace, path)
      if (!existsSync(absolute)) worktree.push(`${path}\0(deleted)`)
      else {
        const info = lstatSync(absolute)
        worktree.push(`${path}\0${info.mode & 0o777}\0${await git(['hash-object', '--no-filters', '--', path], workspace)}`)
      }
    }
    const fingerprint = createHash('sha256')
      .update(head).update('\0').update(status).update('\0').update(index).update('\0').update(worktree.join('\0'))
      .digest('hex')
    return { message, paths, fingerprint }
  } catch (error) {
    return { message, paths, fingerprint: '', error: error instanceof Error ? error.message : 'state Git tidak dapat diperiksa' }
  }
}

async function gitIndexPath(workspace: string): Promise<string> {
  const path = await git(['rev-parse', '--git-path', 'index'], workspace)
  return isAbsolute(path) ? path : resolve(workspace, path)
}

/** Mengembalikan index persis seperti sebelum staging bila commit gagal. */
function restoreIndex(path: string, before: Buffer | null): void {
  if (before === null) {
    try { unlinkSync(path) } catch { /* index memang dapat belum ada pada repository baru */ }
    return
  }
  writeFileSync(path, before)
}

export const gitCommitTool: Tool<CommitArgs> = {
  name: 'git_commit',
  description: 'Create one local Git commit containing only explicitly listed changed files. Use only when the user explicitly asks for a commit.',
  risk: 'confirm',
  allowAlways: false,
  writesWorkspace: true,
  runsCommand: true,
  schema: {
    type: 'function',
    function: {
      name: 'git_commit',
      description: 'Create a local Git commit from the complete current contents of explicitly listed files. Other staged changes remain staged. Never use unless the user explicitly requested a commit. Git hooks and signing are disabled for this controlled operation.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: `Commit subject/body, at most ${MAX_COMMIT_MESSAGE_CHARACTERS} characters` },
          paths: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_COMMIT_PATHS,
            items: { type: 'string' },
            description: 'Exact changed file paths to include; directories and implicit all-files commits are rejected',
          },
        },
        required: ['message', 'paths'],
      },
    },
  },
  preview: (args) => `git commit · ${typeof args.message === 'string' ? args.message.split(/\r?\n/, 1)[0] : ''} · ${Array.isArray(args.paths) ? args.paths.length : 0} file`,
  async detail(args, context) {
    const state = await commitState(args, context.workspace)
    commitPreviews.set(args, state)
    return null
  },
  async run(args, context) {
    const previewed = commitPreviews.get(args)
    if (previewed?.error) return { content: `Gagal: ${previewed.error}`, isError: true }
    const current = await commitState(args, context.workspace)
    if (current.error) return { content: `Gagal: ${current.error}`, isError: true }
    if (previewed && previewed.fingerprint !== current.fingerprint) {
      return { content: 'Gagal: file, index, atau HEAD berubah setelah pratinjau approval. Periksa git_status lalu minta commit lagi.', isError: true }
    }

    let indexPath = ''
    let indexBefore: Buffer | null = null
    let staged = false
    const hooksDirectory = mkdtempSync(join(tmpdir(), 'boo-git-hooks-disabled-'))
    try {
      indexPath = await gitIndexPath(context.workspace)
      indexBefore = existsSync(indexPath) ? readFileSync(indexPath) : null
      staged = true
      await gitWrite(['add', '-A', '--', ...current.paths], context.workspace)
      const output = await gitWrite([
        '-c', `core.hooksPath=${hooksDirectory}`,
        '-c', 'commit.gpgsign=false',
        'commit', '--only', '--no-gpg-sign', '-m', current.message, '--', ...current.paths,
      ], context.workspace)
      const id = await git(['rev-parse', '--short', 'HEAD'], context.workspace)
      return {
        content: `Commit ${id} dibuat untuk ${current.paths.length} file. Perubahan staged lain tetap dipertahankan. Git hooks dan signing tidak dijalankan.${output ? `\n${output}` : ''}`,
      }
    } catch (error) {
      let restoreError = ''
      if (staged && indexPath) {
        try {
          restoreIndex(indexPath, indexBefore)
        } catch (restore) {
          restoreError = ` Peringatan: index Git tidak dapat dipulihkan otomatis (${restore instanceof Error ? restore.message : 'kesalahan tidak dikenal'}).`
        }
      }
      const restored = restoreError ? '' : ' Staging sebelum percobaan dipulihkan.'
      return { content: `Gagal membuat commit.${restored}${restoreError} ${error instanceof Error ? error.message : 'git commit gagal'}`.trim(), isError: true }
    } finally {
      rmSync(hooksDirectory, { recursive: true, force: true })
    }
  },
}
