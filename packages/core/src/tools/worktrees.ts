/** Git worktree terisolasi untuk sub-agent penulis. */

import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { CheckpointFileChange } from '../agent/checkpoints.ts'
import type { FileSnapshots } from './fileSnapshots.ts'
import { isProtectedWorkspacePath } from './sandbox.ts'
import { isSensitivePath } from './secrets.ts'
import { commandEnvironment } from './shell.ts'
import { resolveInWorkspace } from './workspace.ts'

const execFileAsync = promisify(execFile)
export const WORKTREE_DIRECTORY = 'worktrees'
const WORKTREE_VERSION = 1
const MAX_SNAPSHOT_FILES = 20_000
const MAX_SNAPSHOT_BYTES = 128 * 1024 * 1024
const MAX_MERGE_BYTES = 64 * 1024 * 1024

interface BatchManifest {
  version: 1
  pid: number
  createdAt: number
}

export interface WorktreeLease {
  id: string
  path: string
}

export interface WorktreeMergeContext {
  checkpoint?: {
    beforeWrite(absolutePath: string): Promise<void>
    afterWrite(absolutePath: string): Promise<void>
  }
  fileSnapshots?: FileSnapshots
}

export interface WorktreeMergeResult {
  applied: string[]
  conflicts: string[]
}

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function git(args: string[], cwd: string, signal?: AbortSignal): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      env: { ...commandEnvironment(), GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat' },
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      timeout: 60_000,
      signal,
    })
    return stdout
  } catch (error) {
    const detail = error as Error & { stderr?: string }
    throw new Error(detail.stderr?.trim() || detail.message, { cause: error })
  }
}

function safeRelative(path: string): string {
  const normalized = path.split('\\').join('/')
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..') || isAbsolute(path)) {
    throw new Error(`Git mengembalikan path tidak aman: ${path}`)
  }
  return normalized
}

function nulPaths(output: string): string[] {
  return output.split('\0').filter(Boolean).map(safeRelative)
}

async function snapshotPaths(workspace: string, signal?: AbortSignal): Promise<string[]> {
  const [unstaged, staged, untracked] = await Promise.all([
    git(['diff', '--name-only', '-z', 'HEAD'], workspace, signal),
    git(['diff', '--cached', '--name-only', '-z', 'HEAD'], workspace, signal),
    git(['ls-files', '--others', '--exclude-standard', '-z'], workspace, signal),
  ])
  const paths = [...new Set([...nulPaths(unstaged), ...nulPaths(staged), ...nulPaths(untracked)])]
  if (paths.length > MAX_SNAPSHOT_FILES) throw new Error(`Snapshot worktree melebihi ${MAX_SNAPSHOT_FILES} file berubah.`)
  return paths
}

async function copyVisibleState(workspace: string, targetRoot: string, signal?: AbortSignal): Promise<void> {
  const paths = await snapshotPaths(workspace, signal)
  let bytes = 0
  for (const label of paths) {
    if (signal?.aborted) throw new Error('Dibatalkan oleh pengguna.')
    const source = join(workspace, label)
    const target = join(targetRoot, label)
    let info
    try {
      info = await lstat(source)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await rm(target, { force: true, recursive: true })
      continue
    }
    // Parent target harus tetap berada di worktree; target lama boleh berupa
    // symlink dari HEAD dan dihapus sebelum salinan ditulis.
    resolveInWorkspace(targetRoot, dirname(label))
    await rm(target, { force: true, recursive: true })
    await mkdir(dirname(target), { recursive: true })
    if (info.isSymbolicLink()) {
      await symlink(await readlink(source), target)
      continue
    }
    if (!info.isFile()) continue
    bytes += info.size
    if (bytes > MAX_SNAPSHOT_BYTES) throw new Error('Snapshot perubahan workspace melebihi batas 128 MB.')
    await copyFile(source, target)
    await chmod(target, info.mode & 0o777)
  }
}

async function repositoryRoot(workspace: string, signal?: AbortSignal): Promise<string> {
  const [root, current] = await Promise.all([
    git(['rev-parse', '--show-toplevel'], workspace, signal).then((value) => realpath(value.trim())),
    realpath(workspace),
  ])
  if (root !== current) throw new Error('Sub-agent worktree saat ini mengharuskan Boo dijalankan dari akar repository Git.')
  await git(['rev-parse', '--verify', 'HEAD'], workspace, signal)
  return root
}

async function cleanupStale(storageRoot: string, workspace: string): Promise<void> {
  let entries
  try {
    entries = await readdir(storageRoot, { withFileTypes: true })
  } catch {
    return
  }
  let pruned = false
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('batch-')) continue
    const batch = join(storageRoot, entry.name)
    let manifest: BatchManifest
    try {
      manifest = JSON.parse(await readFile(join(batch, 'manifest.json'), 'utf8')) as BatchManifest
    } catch {
      continue
    }
    if (manifest.version !== WORKTREE_VERSION || alive(manifest.pid)) continue
    const children = await readdir(batch, { withFileTypes: true }).catch(() => [])
    for (const child of children) {
      if (!child.isDirectory() || !/^task-[a-z0-9_-]+$/i.test(child.name)) continue
      await git(['worktree', 'remove', '--force', join(batch, child.name)], workspace).catch(() => undefined)
    }
    await rm(batch, { recursive: true, force: true })
    pruned = true
  }
  if (pruned) await git(['worktree', 'prune'], workspace).catch(() => undefined)
}

export class IsolatedWorktreeBatch {
  readonly workspace: string
  readonly root: string
  private readonly leases: WorktreeLease[] = []
  private closed = false

  private constructor(workspace: string, root: string) {
    this.workspace = workspace
    this.root = root
  }

  static async create(options: { workspace: string; home?: string; signal?: AbortSignal }): Promise<IsolatedWorktreeBatch> {
    const workspace = await repositoryRoot(options.workspace, options.signal)
    const workspaceId = createHash('sha256').update(workspace).digest('hex').slice(0, 24)
    const base = options.home
      ? join(options.home, '.boo', WORKTREE_DIRECTORY, workspaceId)
      : join(tmpdir(), 'boo-worktrees', workspaceId)
    await mkdir(base, { recursive: true, mode: 0o700 })
    await cleanupStale(base, workspace)
    const root = await mkdtemp(join(base, 'batch-'))
    await chmod(root, 0o700)
    await writeFile(join(root, 'manifest.json'), `${JSON.stringify({ version: WORKTREE_VERSION, pid: process.pid, createdAt: Date.now() })}\n`, { mode: 0o600 })
    return new IsolatedWorktreeBatch(workspace, root)
  }

  async prepare(id: string, signal?: AbortSignal): Promise<WorktreeLease> {
    if (this.closed) throw new Error('Batch worktree sudah ditutup.')
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(id)) throw new Error(`ID worktree tidak valid: ${id}`)
    const path = join(this.root, `task-${id}`)
    await git(['worktree', 'add', '--detach', path, 'HEAD'], this.workspace, signal)
    try {
      await copyVisibleState(this.workspace, path, signal)
    } catch (error) {
      await git(['worktree', 'remove', '--force', path], this.workspace).catch(() => undefined)
      throw error
    }
    const lease = { id, path }
    this.leases.push(lease)
    return lease
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const lease of this.leases) {
      await git(['worktree', 'remove', '--force', lease.path], this.workspace).catch(async () => {
        await rm(lease.path, { recursive: true, force: true })
      })
    }
    await rm(this.root, { recursive: true, force: true })
    await git(['worktree', 'prune'], this.workspace).catch(() => undefined)
  }
}

function same(left: Buffer | null, right: Buffer | null): boolean {
  return left === null ? right === null : right !== null && left.equals(right)
}

async function readOrNull(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** Merge per task bersifat all-or-nothing dan selalu memeriksa snapshot awal. */
export async function mergeWorktreeChanges(
  workspace: string,
  changes: readonly CheckpointFileChange[],
  context: WorktreeMergeContext = {},
): Promise<WorktreeMergeResult> {
  const prepared: Array<{ label: string; absolute: string; beforeMain: Buffer | null; after: Buffer | null; mode: number | null }> = []
  const conflicts: string[] = []
  let bytes = 0
  for (const change of changes) {
    const label = safeRelative(change.label)
    if (isProtectedWorkspacePath(label) || isSensitivePath(label)) {
      conflicts.push(label)
      continue
    }
    const absolute = resolveInWorkspace(workspace, label)
    const beforeMain = await readOrNull(absolute)
    if (!same(beforeMain, change.before)) {
      conflicts.push(label)
      continue
    }
    if (same(change.before, change.after)) continue
    bytes += change.after?.length ?? 0
    if (bytes > MAX_MERGE_BYTES) throw new Error('Hasil sub-agent melebihi batas merge 64 MB.')
    let mode: number | null = null
    try {
      const info = await lstat(absolute)
      // Mengganti symlink saat merge berbeda dari edit child yang mengikuti
      // targetnya. Laporkan sebagai konflik alih-alih mengubah tipe file diam-diam.
      if (info.isSymbolicLink()) {
        conflicts.push(label)
        continue
      }
      mode = info.mode & 0o777
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    prepared.push({ label, absolute, beforeMain, after: change.after, mode })
  }
  if (conflicts.length) return { applied: [], conflicts }

  for (const file of prepared) await context.checkpoint?.beforeWrite(file.absolute)
  const applied: typeof prepared = []
  try {
    for (const file of prepared) {
      applied.push(file)
      if (file.after) {
        await mkdir(dirname(file.absolute), { recursive: true })
        const temporary = `${file.absolute}.boo-${process.pid}-${Date.now()}-${applied.length}.tmp`
        try {
          await writeFile(temporary, file.after, { flag: 'wx' })
          if (file.mode !== null) await chmod(temporary, file.mode)
          await rename(temporary, file.absolute)
        } finally {
          await rm(temporary, { force: true })
        }
      } else {
        await rm(file.absolute, { force: true })
      }
      await context.checkpoint?.afterWrite(file.absolute)
      context.fileSnapshots?.observe(file.absolute, file.after)
    }
  } catch (error) {
    for (const file of applied.reverse()) {
      if (file.beforeMain) {
        await mkdir(dirname(file.absolute), { recursive: true })
        await writeFile(file.absolute, file.beforeMain)
      } else {
        await rm(file.absolute, { force: true })
      }
      context.fileSnapshots?.observe(file.absolute, file.beforeMain)
    }
    throw error
  }
  return { applied: prepared.map((file) => file.label), conflicts: [] }
}

/** Hanya untuk diagnosis/pengujian lokasi; path workspace asli tidak disimpan. */
export function worktreeStorageRoot(workspace: string, home: string): string {
  const workspaceId = createHash('sha256').update(realpathSync(resolve(workspace))).digest('hex').slice(0, 24)
  return join(home, '.boo', WORKTREE_DIRECTORY, workspaceId)
}
