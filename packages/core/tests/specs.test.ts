import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  designPrompt,
  listSpecs,
  nextTask,
  parseTasks,
  readSpec,
  requirementsPrompt,
  revisePrompt,
  slugify,
  specPromptTitle,
  taskPrompt,
  tasksPrompt,
  uniqueSpecName,
} from '../src/spec/specs.ts'

test('tasks.md: checkbox bernomor, sub-tugas, dan tanda tebal dikenali', () => {
  const tasks = parseTasks([
    '# Tasks: Login',
    '',
    '- [x] 1. Buat **model** pengguna',
    '  - rincian yang bukan checkbox',
    '  - _Requirements: 1.1_',
    '- [ ] 2. Tambah endpoint login',
    '  - [X] 2.1 Validasi masukan',
    '  - [ ] 2.2 Kembalikan token',
    '* [ ] Tanpa nomor',
  ].join('\n'))
  assert.deepEqual(tasks.map((task) => [task.number, task.title, task.done, task.line]), [
    ['1', 'Buat model pengguna', true, 3],
    ['2', 'Tambah endpoint login', false, 6],
    ['2.1', 'Validasi masukan', true, 7],
    ['2.2', 'Kembalikan token', false, 8],
    ['5', 'Tanpa nomor', false, 9],
  ])
})

test('nama spec aman untuk folder, dan tidak menimpa yang sudah ada', () => {
  assert.equal(slugify('Login dengan Google & GitHub (OAuth)!'), 'login-dengan-google-github-oauth')
  assert.equal(slugify('Café résumé'), 'cafe-resume')
  assert.equal(slugify('    '), 'fitur')
  assert.equal(slugify('satu dua tiga empat lima enam tujuh delapan'), 'satu-dua-tiga-empat-lima-enam')

  const workspace = mkdtempSync(join(tmpdir(), 'boo-spec-'))
  mkdirSync(join(workspace, '.boo/specs/login'), { recursive: true })
  assert.equal(uniqueSpecName(workspace, 'Login'), 'login-2')
})

test('tahap spec mengikuti berkas yang ada dan kemajuan tugasnya', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'boo-spec-'))
  const dir = join(workspace, '.boo/specs/fitur')
  mkdirSync(dir, { recursive: true })
  const stage = () => readSpec(workspace, 'fitur')?.stage

  assert.equal(stage(), 'requirements')
  writeFileSync(join(dir, 'requirements.md'), '# R')
  assert.equal(stage(), 'design')
  writeFileSync(join(dir, 'design.md'), '# D')
  assert.equal(stage(), 'tasks')
  writeFileSync(join(dir, 'tasks.md'), '# T\n\nbelum ada checkbox')
  assert.equal(stage(), 'tasks', 'tasks.md tanpa checkbox belum dianggap siap')
  writeFileSync(join(dir, 'tasks.md'), '- [x] 1. a\n- [ ] 2. b\n')
  assert.equal(stage(), 'implementing')
  assert.equal(nextTask(readSpec(workspace, 'fitur')!)?.title, 'b')
  writeFileSync(join(dir, 'tasks.md'), '- [x] 1. a\n- [x] 2. b\n')
  assert.equal(stage(), 'done')

  assert.equal(readSpec(workspace, 'tidak-ada'), null)
  assert.deepEqual(listSpecs(workspace).map((spec) => spec.name), ['fitur'])
  assert.deepEqual(listSpecs(join(workspace, 'kosong')), [])
})

test('permintaan setiap tahap menyebut berkasnya dan dapat diringkas ke judul', () => {
  const task = { number: '2', title: 'Tambah endpoint', done: false, line: 3 }
  const prompts = [
    [requirementsPrompt('login', 'login\ndengan Google'), 'login · requirements — login dengan Google', '.boo/specs/login/requirements.md'],
    [designPrompt('login'), 'login · design', '.boo/specs/login/design.md'],
    [tasksPrompt('login'), 'login · tasks', '.boo/specs/login/tasks.md'],
    [taskPrompt('login', task), 'login · tugas 2 — Tambah endpoint', '[ ] menjadi [x]'],
    [revisePrompt('login', 'design.md', 'pakai JWT'), 'login · revisi design — pakai JWT', '.boo/specs/login/design.md'],
  ]
  for (const [prompt, title, mention] of prompts) {
    assert.equal(specPromptTitle(prompt), title)
    assert.ok(prompt.includes(mention), `${title} menyebut ${mention}`)
  }
  assert.equal(specPromptTitle('pertanyaan biasa'), null)
})
