import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Tool, ToolContext } from '../domain/tool.ts'
import { condense, diffLines, type DiffLine } from './diff.ts'
import { FILE_CHANGED_MESSAGE } from './fileSnapshots.ts'
import { isProtectedWorkspacePath } from './sandbox.ts'
import { isSensitivePath, sensitiveRefusal } from './secrets.ts'
import { resolveInWorkspace } from './workspace.ts'

type PatchKind = 'add' | 'update' | 'delete'
interface PatchHunk { oldLines: string[]; newLines: string[] }
export interface PatchOperation { kind: PatchKind; path: string; hunks: PatchHunk[]; content?: string }

const HEADER = /^\*\*\* (Add|Update|Delete) File: (.+)$/

/** Parser patch yang sengaja ketat: kegagalan konteks harus terlihat, bukan ditebak. */
export function parsePatch(source: string): PatchOperation[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  if (lines[0] !== '*** Begin Patch') throw new Error('Patch harus dimulai dengan "*** Begin Patch".')
  const operations: PatchOperation[] = []
  let index = 1
  while (index < lines.length && lines[index] !== '*** End Patch') {
    const header = HEADER.exec(lines[index])
    if (!header) throw new Error(`Header patch tidak valid pada baris ${index + 1}.`)
    const kind = header[1].toLowerCase() as PatchKind
    const path = header[2].trim()
    if (!path) throw new Error('Path patch tidak boleh kosong.')
    index += 1
    const body: string[] = []
    while (index < lines.length && lines[index] !== '*** End Patch' && !HEADER.test(lines[index])) body.push(lines[index++])

    if (kind === 'delete') {
      if (body.some((line) => line.length)) throw new Error(`Delete File ${path} tidak boleh memiliki isi patch.`)
      operations.push({ kind, path, hunks: [] })
      continue
    }
    if (kind === 'add') {
      if (!body.length || body.some((line) => !line.startsWith('+'))) {
        throw new Error(`Setiap baris Add File ${path} harus diawali +.`)
      }
      operations.push({ kind, path, hunks: [], content: body.map((line) => line.slice(1)).join('\n') })
      continue
    }

    const hunks: PatchHunk[] = []
    let current: PatchHunk | null = null
    for (const line of body) {
      if (line.startsWith('@@')) {
        current = { oldLines: [], newLines: [] }
        hunks.push(current)
        continue
      }
      if (line === '\\ No newline at end of file') continue
      if (!current) throw new Error(`Update File ${path} harus memiliki penanda @@ sebelum isi.`)
      const marker = line[0]
      const text = line.slice(1)
      if (marker === ' ' || marker === '-') current.oldLines.push(text)
      if (marker === ' ' || marker === '+') current.newLines.push(text)
      if (marker !== ' ' && marker !== '+' && marker !== '-') {
        throw new Error(`Baris update ${path} harus diawali spasi, +, atau -.`)
      }
    }
    if (!hunks.length || hunks.some((hunk) => !hunk.oldLines.length)) {
      throw new Error(`Update File ${path} membutuhkan hunk dengan konteks atau baris yang dihapus.`)
    }
    operations.push({ kind, path, hunks })
  }
  if (lines[index] !== '*** End Patch') throw new Error('Patch harus diakhiri dengan "*** End Patch".')
  if (lines.slice(index + 1).some((line) => line.trim())) throw new Error('Tidak boleh ada teks setelah "*** End Patch".')
  if (!operations.length) throw new Error('Patch tidak berisi perubahan.')
  const paths = operations.map((operation) => operation.path)
  if (new Set(paths).size !== paths.length) throw new Error('Satu path hanya boleh muncul sekali dalam satu patch.')
  return operations
}

function replaceHunks(path: string, source: string, hunks: PatchHunk[]): string {
  let result = source
  for (const hunk of hunks) {
    const before = hunk.oldLines.join('\n')
    const after = hunk.newLines.join('\n')
    const first = result.indexOf(before)
    if (first === -1) throw new Error(`Konteks patch tidak ditemukan di ${path}. Baca ulang file dan buat patch baru.`)
    if (result.indexOf(before, first + 1) !== -1) {
      throw new Error(`Konteks patch muncul lebih dari sekali di ${path}. Tambahkan baris konteks agar unik.`)
    }
    result = `${result.slice(0, first)}${after}${result.slice(first + before.length)}`
  }
  return result
}

interface Prepared {
  operation: PatchOperation
  absolute: string
  before: Buffer | null
  after: Buffer | null
}

async function readOrNull(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function prepare(patch: string, context: ToolContext): Promise<Prepared[]> {
  const operations = parsePatch(patch)
  const prepared: Prepared[] = []
  for (const operation of operations) {
    if (isProtectedWorkspacePath(operation.path)) throw new Error(`${operation.path} adalah path agent yang dilindungi.`)
    if (isSensitivePath(operation.path)) throw new Error(sensitiveRefusal(operation.path))
    const absolute = resolveInWorkspace(context.workspace, operation.path)
    const before = await readOrNull(absolute)
    context.fileSnapshots?.capture(absolute, before)
    if (context.fileSnapshots && !context.fileSnapshots.matches(absolute, before)) {
      throw new Error(FILE_CHANGED_MESSAGE(operation.path))
    }
    if (operation.kind === 'add' && before) throw new Error(`Add File gagal: ${operation.path} sudah ada.`)
    if (operation.kind !== 'add' && !before) throw new Error(`${operation.kind === 'delete' ? 'Delete' : 'Update'} File gagal: ${operation.path} tidak ada.`)
    if (before?.subarray(0, 8_000).includes(0)) throw new Error(`${operation.path} adalah file biner.`)
    const after = operation.kind === 'delete'
      ? null
      : Buffer.from(operation.kind === 'add' ? operation.content ?? '' : replaceHunks(operation.path, before!.toString('utf8'), operation.hunks))
    prepared.push({ operation, absolute, before, after })
  }
  return prepared
}

function patchSummary(patch: string): string {
  try {
    const operations = parsePatch(patch)
    const names = operations.map((operation) => operation.path)
    return `terapkan patch ${names.length} file: ${names.join(', ')}`
  } catch {
    return 'terapkan patch'
  }
}

export const applyPatchTool: Tool<{ patch: string }> = {
  name: 'apply_patch',
  description: `Apply one validated multi-file patch atomically. Format: *** Begin Patch, then *** Update File: path with @@ hunks whose lines start with space/+/-; *** Add File: path with every line starting +; or *** Delete File: path; then *** End Patch. Use exact, unique context.`,
  risk: 'confirm',
  writesWorkspace: true,
  mutatesWorkspace: true,
  schema: {
    type: 'function',
    function: {
      name: 'apply_patch',
      description: 'Apply a precise multi-file patch after validating every file and hunk.',
      parameters: {
        type: 'object',
        properties: { patch: { type: 'string', description: 'Complete *** Begin Patch ... *** End Patch document' } },
        required: ['patch'],
      },
    },
  },
  preview: (args) => patchSummary(args.patch),
  async detail(args, context): Promise<DiffLine[] | null> {
    const files = await prepare(args.patch, context)
    const output: DiffLine[] = []
    for (const file of files) {
      output.push({ kind: 'context', text: `── ${file.operation.path} ──` })
      output.push(...condense(diffLines(file.before?.toString('utf8') ?? '', file.after?.toString('utf8') ?? '')))
    }
    return output
  },
  async run(args, context) {
    let files: Prepared[]
    try {
      files = await prepare(args.patch, context)
    } catch (error) {
      return { content: `Gagal: ${error instanceof Error ? error.message : 'patch tidak valid'}`, isError: true }
    }
    for (const file of files) await context.checkpoint?.beforeWrite(file.absolute)
    const applied: Prepared[] = []
    try {
      for (const file of files) {
        applied.push(file)
        if (file.after) {
          await mkdir(dirname(file.absolute), { recursive: true })
          await writeFile(file.absolute, file.after)
        } else {
          await rm(file.absolute)
        }
        await context.checkpoint?.afterWrite(file.absolute)
      }
    } catch (error) {
      for (const file of applied.reverse()) {
        if (file.before) {
          await mkdir(dirname(file.absolute), { recursive: true })
          await writeFile(file.absolute, file.before)
        } else {
          await rm(file.absolute, { force: true })
        }
        context.fileSnapshots?.observe(file.absolute, file.before)
      }
      return { content: `Gagal menerapkan patch; perubahan sebelumnya dipulihkan: ${error instanceof Error ? error.message : 'error tidak dikenal'}`, isError: true }
    }
    for (const file of files) context.fileSnapshots?.observe(file.absolute, file.after)
    return { content: `Patch diterapkan: ${files.map((file) => file.operation.path).join(', ')}` }
  },
}
