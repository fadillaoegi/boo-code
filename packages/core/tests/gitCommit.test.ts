import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { gitCommitTool } from '../src/tools/git.ts'

function git(workspace: string, args: string[]): string {
  return execFileSync('git', args, { cwd: workspace, encoding: 'utf8' }).trim()
}

function repository(): string {
  const workspace = mkdtempSync(join(tmpdir(), 'boo-git-commit-'))
  git(workspace, ['init', '--quiet'])
  git(workspace, ['config', 'user.name', 'Boo Test'])
  git(workspace, ['config', 'user.email', 'boo@example.invalid'])
  writeFileSync(join(workspace, 'a.txt'), 'a awal\n')
  writeFileSync(join(workspace, 'b.txt'), 'b awal\n')
  git(workspace, ['add', 'a.txt', 'b.txt'])
  git(workspace, ['commit', '--quiet', '-m', 'initial'])
  return workspace
}

test('git_commit hanya memasukkan path eksplisit dan mempertahankan staged change lain', async () => {
  const workspace = repository()
  await writeFile(join(workspace, 'a.txt'), 'a baru\n')
  await writeFile(join(workspace, 'b.txt'), 'b baru\n')
  git(workspace, ['add', 'b.txt'])

  // Hook repository tidak boleh berjalan diam-diam dari approval commit.
  const hook = join(workspace, '.git', 'hooks', 'pre-commit')
  writeFileSync(hook, '#!/bin/sh\nexit 91\n')
  chmodSync(hook, 0o755)

  const args = { message: 'feat: ubah a', paths: ['a.txt'] }
  await gitCommitTool.detail?.(args, { workspace })
  const result = await gitCommitTool.run(args, { workspace })
  assert.equal(result.isError, undefined, result.content)
  assert.match(result.content, /Commit [a-f0-9]+ dibuat untuk 1 file/)
  assert.deepEqual(git(workspace, ['show', '--pretty=', '--name-only', 'HEAD']).split('\n').filter(Boolean), ['a.txt'])
  assert.deepEqual(git(workspace, ['diff', '--cached', '--name-only']).split('\n').filter(Boolean), ['b.txt'])
  assert.equal(git(workspace, ['show', 'HEAD:a.txt']), 'a baru')
  assert.equal(git(workspace, ['show', 'HEAD:b.txt']), 'b awal')
})

test('git_commit membatalkan commit bila file berubah setelah preview approval', async () => {
  const workspace = repository()
  await writeFile(join(workspace, 'a.txt'), 'versi saat preview\n')
  const before = git(workspace, ['rev-parse', 'HEAD'])
  const args = { message: 'ubah a', paths: ['a.txt'] }
  await gitCommitTool.detail?.(args, { workspace })
  await writeFile(join(workspace, 'a.txt'), 'berubah saat approval\n')

  const result = await gitCommitTool.run(args, { workspace })
  assert.equal(result.isError, true)
  assert.match(result.content, /berubah setelah pratinjau approval/)
  assert.equal(git(workspace, ['rev-parse', 'HEAD']), before)
  assert.equal(git(workspace, ['diff', '--cached', '--name-only']), '')
})

test('git_commit memulihkan index persis bila commit gagal', async () => {
  const workspace = repository()
  await writeFile(join(workspace, 'a.txt'), 'a baru\n')
  await writeFile(join(workspace, 'b.txt'), 'b baru\n')
  git(workspace, ['add', 'b.txt'])
  git(workspace, ['config', 'user.name', ''])
  const before = git(workspace, ['rev-parse', 'HEAD'])
  const args = { message: 'commit yang gagal', paths: ['a.txt'] }
  await gitCommitTool.detail?.(args, { workspace })

  const result = await gitCommitTool.run(args, { workspace })
  assert.equal(result.isError, true)
  assert.match(result.content, /Staging sebelum percobaan dipulihkan/)
  assert.equal(git(workspace, ['rev-parse', 'HEAD']), before)
  assert.deepEqual(git(workspace, ['diff', '--cached', '--name-only']).split('\n').filter(Boolean), ['b.txt'])
  assert.deepEqual(git(workspace, ['diff', '--name-only']).split('\n').filter(Boolean), ['a.txt'])
})

test('git_commit mendukung commit pertama dan menolak path berbahaya', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'boo-git-first-'))
  git(workspace, ['init', '--quiet'])
  git(workspace, ['config', 'user.name', 'Boo Test'])
  git(workspace, ['config', 'user.email', 'boo@example.invalid'])
  await writeFile(join(workspace, 'first.txt'), 'pertama\n')

  const first = await gitCommitTool.run({ message: 'initial', paths: ['first.txt'] }, { workspace })
  assert.equal(first.isError, undefined, first.content)
  assert.equal(git(workspace, ['show', 'HEAD:first.txt']), 'pertama')

  assert.equal((await gitCommitTool.run({ message: 'secret', paths: ['.env'] }, { workspace })).isError, true)
  assert.equal((await gitCommitTool.run({ message: 'metadata', paths: ['.git/config'] }, { workspace })).isError, true)
  assert.equal((await gitCommitTool.run({ message: 'semua', paths: ['.'] }, { workspace })).isError, true)
  assert.equal((await gitCommitTool.run({ message: 'keluar', paths: ['../outside.txt'] }, { workspace })).isError, true)
  assert.equal((await gitCommitTool.run({ message: 'pathspec', paths: [':(glob)*'] }, { workspace })).isError, true)
})
