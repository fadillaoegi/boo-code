import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitBlameTool, gitLogTool, gitShowTool, MAX_GIT_BLAME_LINES } from '../src/tools/git.ts'

function git(workspace: string, args: string[]): string {
  return execFileSync('git', args, { cwd: workspace, encoding: 'utf8' }).trim()
}

function commit(workspace: string, message: string, name: string): string {
  git(workspace, ['add', '-A'])
  git(workspace, ['-c', `user.name=${name}`, '-c', 'user.email=history@example.invalid', 'commit', '--quiet', '-m', message])
  return git(workspace, ['rev-parse', 'HEAD'])
}

function repository() {
  const workspace = mkdtempSync(join(tmpdir(), 'boo-git-history-'))
  git(workspace, ['init', '--quiet', '--initial-branch=main'])
  writeFileSync(join(workspace, 'app.ts'), 'export const value = 1\nexport const stable = true\n')
  writeFileSync(join(workspace, '.env'), 'SECRET=history-secret\n')
  const initial = commit(workspace, 'initial behavior', 'Initial Author')
  writeFileSync(join(workspace, 'app.ts'), 'export const value = 2\nexport const stable = true\n')
  const latest = commit(workspace, `fix value ${String.fromCharCode(27)}[31m`, 'Latest Author')
  return { workspace, initial, latest }
}

test('git_log membatasi commit, mendukung filter path, dan tidak mengembalikan email/kontrol terminal', async () => {
  const { workspace, latest } = repository()
  const result = await gitLogTool.run({ path: 'app.ts', max_count: 1 }, { workspace })
  assert.equal(result.isError, undefined)
  assert.match(result.content, new RegExp(latest.slice(0, 7)))
  assert.match(result.content, /Latest Author/)
  assert.match(result.content, /fix value \\u001b\[31m/)
  assert.doesNotMatch(result.content, /example\.invalid/)
  assert.doesNotMatch(result.content, /initial behavior/)
  assert.equal((await gitLogTool.run({ ref: '--all' }, { workspace })).isError, true)
})

test('git_show menampilkan metadata dan patch satu file pada revision aman', async () => {
  const { workspace, latest } = repository()
  const result = await gitShowTool.run({ ref: latest, path: 'app.ts' }, { workspace })
  assert.equal(result.isError, undefined)
  assert.match(result.content, new RegExp(`commit ${latest}`))
  assert.match(result.content, /Author: Latest Author/)
  assert.match(result.content, /-export const value = 1/)
  assert.match(result.content, /\+export const value = 2/)
  assert.doesNotMatch(result.content, /example\.invalid/)
})

test('git_blame memberi line, commit, tanggal, author, subject, dan source dalam rentang terbatas', async () => {
  const { workspace, initial, latest } = repository()
  const result = await gitBlameTool.run({ path: 'app.ts', start_line: 1, end_line: 2 }, { workspace })
  assert.equal(result.isError, undefined)
  const lines = result.content.split('\n')
  assert.equal(lines.length, 2)
  assert.match(lines[0], new RegExp(`^1\\t${latest.slice(0, 10)}`))
  assert.match(lines[0], /Latest Author · fix value/)
  assert.match(lines[0], /\| export const value = 2/)
  assert.match(lines[1], new RegExp(`^2\\t${initial.slice(0, 10)}`))
  assert.match(lines[1], /Initial Author · initial behavior/)
  assert.doesNotMatch(result.content, /example\.invalid/)

  assert.equal((await gitBlameTool.run({ path: 'app.ts', start_line: 3, end_line: 2 }, { workspace })).isError, true)
  assert.equal((await gitBlameTool.run({ path: 'app.ts', start_line: 1, end_line: MAX_GIT_BLAME_LINES + 1 }, { workspace })).isError, true)
})

test('tool sejarah Git menolak file credential dan path keluar workspace', async () => {
  const { workspace, latest } = repository()
  for (const result of [
    await gitLogTool.run({ path: '.env' }, { workspace }),
    await gitShowTool.run({ ref: latest, path: '.env' }, { workspace }),
    await gitBlameTool.run({ path: '.env' }, { workspace }),
    await gitShowTool.run({ ref: latest, path: '../outside.ts' }, { workspace }),
  ]) {
    assert.equal(result.isError, true)
    assert.doesNotMatch(result.content, /history-secret/)
  }
})
