import assert from 'node:assert/strict'
import test from 'node:test'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expandPromptReferences } from '../src/agent/references.ts'

// HOME dialihkan sebelum modul dimuat, karena lokasi sesi dihitung saat impor.
// Sesi asli pengguna di ~/.boo tidak boleh tersentuh oleh tes.
const fakeHome = mkdtempSync(join(tmpdir(), 'boo-home-'))
process.env.HOME = fakeHome
const sessions = await import('../src/session/sessions.ts')
const { forkSession, forkSessionAt, SessionRecorder, SessionError, listSessions, loadSession, resolveSessionId, sessionTurns, SESSIONS_DIR } = sessions

const WORKSPACE = '/proyek/satu'

function recorder(options: { workspace?: string; model?: string; resumeId?: string } = {}) {
  return new SessionRecorder({
    workspace: options.workspace ?? WORKSPACE,
    model: options.model ?? 'ag/claude-sonnet-4-6',
    resumeId: options.resumeId,
  })
}

test('lokasi sesi berada di HOME tes, bukan milik pengguna', () => {
  assert.ok(SESSIONS_DIR.startsWith(fakeHome))
})

test('sesi tanpa pesan tidak meninggalkan berkas', () => {
  const session = recorder()
  session.recordModel('cx/gpt-5.6-sol', 'high')
  assert.equal(session.started, false)
  assert.ok(!existsSync(join(SESSIONS_DIR, `${session.id}.jsonl`)))
})

test('pesan dan pergantian model dipulihkan sesuai urutan', () => {
  const session = recorder()
  session.recordModel('cx/gpt-5.6-sol', 'xhigh')
  session.recordMessage({ role: 'user', content: 'baca a.txt' })
  session.recordMessage({ role: 'assistant', content: 'isinya satu' })
  session.recordModel('ag/gemini-3.7-flash-high', undefined)
  session.recordMessage({ role: 'user', content: 'lanjut' })

  const loaded = loadSession(session.id)
  assert.deepEqual(loaded.messages.map((m) => m.content), ['baca a.txt', 'isinya satu', 'lanjut'])
  assert.equal(loaded.model, 'ag/gemini-3.7-flash-high')
  assert.equal(loaded.reasoningEffort, undefined)
  assert.equal(loaded.workspace, WORKSPACE)
  assert.equal(loaded.title, 'baca a.txt')
})

test('judul sesi dengan @path memakai prompt asli, bukan konteks file internal', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'boo-session-reference-'))
  writeFileSync(join(workspace, 'app.ts'), 'export const internal = true\n')
  const session = recorder({ workspace })
  const expanded = expandPromptReferences('Jelaskan @app.ts', workspace)
  session.recordMessage({ role: 'user', content: expanded.prompt })
  assert.equal(listSessions(workspace).find((item) => item.id === session.id)?.title, 'Jelaskan @app.ts')
})

test('referensi attachment gambar dipulihkan tanpa menyimpan base64', () => {
  const session = recorder()
  const image = {
    id: 'a'.repeat(20), name: 'error.png', mediaType: 'image/png' as const,
    ref: `${session.id}/${'a'.repeat(64)}.png`, bytes: 128,
  }
  session.recordMessage({ role: 'user', content: 'jelaskan gambar', images: [image] })
  const loaded = loadSession(session.id)
  assert.deepEqual(loaded.messages[0].images, [image])
  const raw = readFileSync(join(SESSIONS_DIR, `${session.id}.jsonl`), 'utf8')
  assert.doesNotMatch(raw, /data:image|base64/)
})

test('model yang dipilih sebelum pesan pertama ikut tersimpan', () => {
  const session = recorder()
  session.recordModel('cx/gpt-5.6-luna', 'medium')
  session.recordMessage({ role: 'user', content: 'halo' })
  const loaded = loadSession(session.id)
  assert.equal(loaded.model, 'cx/gpt-5.6-luna')
  assert.equal(loaded.reasoningEffort, 'medium')
})

test('mode Auto tersimpan terpisah dari model terpilih dan dipulihkan saat resume', () => {
  const session = recorder()
  session.recordModelMode('auto')
  session.recordMessage({ role: 'user', content: 'Task berat' })
  session.recordModel('cx/gpt-5.6-sol', 'xhigh')
  assert.equal(loadSession(session.id).modelMode, 'auto')
  assert.equal(loadSession(session.id).model, 'cx/gpt-5.6-sol')
  assert.equal(loadSession(session.id).reasoningEffort, 'xhigh')
  session.recordModelMode('manual')
  session.recordModel('ag/gemini-3.1-pro', undefined)
  assert.equal(loadSession(session.id).modelMode, 'manual')
})

test('baris terakhir yang terpotong karena crash dilewati tanpa merusak sisanya', () => {
  const session = recorder()
  session.recordMessage({ role: 'user', content: 'sebelum crash' })
  session.recordMessage({ role: 'assistant', content: 'jawaban utuh' })
  // Proses mati di tengah penulisan baris berikutnya.
  appendFileSync(join(SESSIONS_DIR, `${session.id}.jsonl`), '{"type":"message","message":{"role":"us')

  const loaded = loadSession(session.id)
  assert.equal(loaded.skippedLines, 1)
  assert.deepEqual(loaded.messages.map((m) => m.content), ['sebelum crash', 'jawaban utuh'])
})

test('melanjutkan sesi menambah ke berkas yang sama', () => {
  const first = recorder()
  first.recordMessage({ role: 'user', content: 'awal' })
  const before = readdirSync(SESSIONS_DIR).length

  const resumed = recorder({ resumeId: first.id })
  assert.equal(resumed.started, true)
  resumed.recordMessage({ role: 'user', content: 'setelah dilanjutkan' })

  assert.equal(readdirSync(SESSIONS_DIR).length, before)
  assert.deepEqual(loadSession(first.id).messages.map((m) => m.content), ['awal', 'setelah dilanjutkan'])
})

test('awalan id cukup untuk memuat sesi, dan awalan ambigu ditolak', () => {
  const session = recorder()
  session.recordMessage({ role: 'user', content: 'x' })
  assert.equal(resolveSessionId(session.id.slice(0, 8)), session.id)
  assert.throws(() => resolveSessionId('tidak-ada-yang-seperti-ini'), SessionError)
  // Awalan kosong cocok dengan semua sesi.
  assert.throws(() => resolveSessionId(''), /cocok dengan/)
})

test('daftar sesi hanya dari workspace yang diminta, terbaru lebih dulu', () => {
  const lama = recorder({ workspace: '/proyek/dua' })
  lama.recordMessage({ role: 'user', content: 'sesi lama' })
  const baru = recorder({ workspace: '/proyek/dua' })
  baru.recordMessage({ role: 'user', content: 'sesi baru' })
  const lain = recorder({ workspace: '/proyek/tiga' })
  lain.recordMessage({ role: 'user', content: 'workspace lain' })

  const past = new Date(Date.now() - 3_600_000)
  utimesSync(join(SESSIONS_DIR, `${lama.id}.jsonl`), past, past)

  const listed = listSessions('/proyek/dua')
  assert.deepEqual(listed.map((s) => s.title), ['sesi baru', 'sesi lama'])
})

test('berkas sesi hanya dapat dibaca pemiliknya', () => {
  const session = recorder()
  session.recordMessage({ role: 'user', content: 'rahasia kecil' })
  const mode = statSync(join(SESSIONS_DIR, `${session.id}.jsonl`)).mode & 0o777
  assert.equal(mode, 0o600)
})

test('melanjutkan sesi yang terpotong tidak merusak rekaman pertama sesudahnya', () => {
  const session = recorder()
  session.recordMessage({ role: 'user', content: 'sebelum crash' })
  // Proses mati di tengah menulis: baris terakhir tanpa baris baru.
  appendFileSync(join(SESSIONS_DIR, `${session.id}.jsonl`), '{"type":"message","message":{"role":"us')

  const resumed = recorder({ resumeId: session.id })
  resumed.recordMessage({ role: 'user', content: 'pertanyaan pertama setelah crash' })
  resumed.recordMessage({ role: 'assistant', content: 'jawabannya' })

  const loaded = loadSession(session.id)
  assert.equal(loaded.skippedLines, 1, 'hanya baris yang terpotong yang dilewati')
  assert.deepEqual(loaded.messages.map((m) => m.content), ['sebelum crash', 'pertanyaan pertama setelah crash', 'jawabannya'])
})

test('ringkasan konteks terakhir dipulihkan bersama sesi', () => {
  const session = recorder()
  session.recordMessage({ role: 'user', content: 'satu' })
  session.recordCompaction({ summary: 'lama', upTo: 1 })
  session.recordMessage({ role: 'assistant', content: 'dua' })
  session.recordCompaction({ summary: 'lebih baru', upTo: 2 })
  const loaded = loadSession(session.id)
  assert.deepEqual(loaded.compaction, { summary: 'lebih baru', upTo: 2 })
  assert.equal(loaded.messages.length, 2)
  assert.equal(loadSession(recorderWithMessage().id).compaction, undefined)
})

test('fork menyalin konteks ke sesi independen tanpa mengubah sesi asal', () => {
  const source = recorder()
  source.recordModelMode('auto')
  source.recordMessage({ role: 'user', content: 'coba pendekatan A' })
  source.recordMessage({ role: 'assistant', content: 'hasil awal' })
  source.recordModel('cx/gpt-5.6-sol', 'xhigh')
  source.recordCompaction({ summary: 'Keputusan awal.', upTo: 2 })
  const sourcePath = join(SESSIONS_DIR, `${source.id}.jsonl`)
  const sourceBefore = readFileSync(sourcePath, 'utf8')

  const branch = forkSession(source.id.slice(0, 8))
  assert.notEqual(branch.id, source.id)
  assert.equal(branch.forkedFrom, source.id)
  assert.equal(branch.workspace, WORKSPACE)
  assert.equal(branch.modelMode, 'auto')
  assert.equal(branch.model, 'cx/gpt-5.6-sol')
  assert.equal(branch.reasoningEffort, 'xhigh')
  assert.deepEqual(branch.messages, loadSession(source.id).messages)
  assert.deepEqual(branch.compaction, { summary: 'Keputusan awal.', upTo: 2 })
  assert.equal(readFileSync(sourcePath, 'utf8'), sourceBefore)
  assert.equal(listSessions(WORKSPACE).find((item) => item.id === branch.id)?.forkedFrom, source.id)
  assert.equal(statSync(join(SESSIONS_DIR, `${branch.id}.jsonl`)).mode & 0o777, 0o600)

  const continued = recorder({ resumeId: branch.id })
  continued.recordMessage({ role: 'user', content: 'di cabang pilih pendekatan B' })
  assert.deepEqual(loadSession(source.id).messages.map((message) => message.content), ['coba pendekatan A', 'hasil awal'])
  assert.deepEqual(loadSession(branch.id).messages.map((message) => message.content), ['coba pendekatan A', 'hasil awal', 'di cabang pilih pendekatan B'])
})

test('rewind membuat cabang sebelum prompt dan memulihkan model historis', () => {
  const source = recorder({ model: 'ag/gemini-3.1-pro' })
  source.recordMessage({ role: 'user', content: 'langkah pertama' })
  source.recordMessage({ role: 'assistant', content: 'hasil pertama' })
  source.recordCompaction({ summary: 'Ringkasan langkah pertama.', upTo: 2 })
  source.recordModelMode('auto')
  source.recordModel('cx/gpt-5.6-sol', 'xhigh')
  source.recordMessage({ role: 'user', content: 'coba pendekatan kedua' })
  source.recordMessage({ role: 'assistant', content: 'hasil kedua' })
  source.recordCompaction({ summary: 'Ringkasan terbaru.', upTo: 4 })
  source.recordModelMode('manual')
  source.recordModel('ag/gemini-3.7-flash-high', undefined)
  const sourcePath = join(SESSIONS_DIR, `${source.id}.jsonl`)
  const sourceBefore = readFileSync(sourcePath, 'utf8')

  const turns = sessionTurns(loadSession(source.id).messages)
  assert.deepEqual(turns.map((turn) => ({ number: turn.number, messageIndex: turn.messageIndex, title: turn.title })), [
    { number: 1, messageIndex: 0, title: 'langkah pertama' },
    { number: 2, messageIndex: 2, title: 'coba pendekatan kedua' },
  ])
  const branch = forkSessionAt(source.id, turns[1]!.messageIndex)
  assert.equal(branch.forkedFrom, source.id)
  assert.equal(branch.forkedAtMessage, 2)
  assert.deepEqual(branch.messages.map((message) => message.content), ['langkah pertama', 'hasil pertama'])
  assert.equal(branch.modelMode, 'auto')
  assert.equal(branch.model, 'cx/gpt-5.6-sol')
  assert.equal(branch.reasoningEffort, 'xhigh')
  assert.deepEqual(branch.compaction, { summary: 'Ringkasan langkah pertama.', upTo: 2 })
  assert.equal(readFileSync(sourcePath, 'utf8'), sourceBefore)

  const continued = recorder({ resumeId: branch.id })
  continued.recordMessage({ role: 'user', content: 'arah baru' })
  assert.equal(loadSession(source.id).messages.length, 4)
  assert.equal(loadSession(branch.id).messages.length, 3)
})

test('rewind ke prompt pertama menghasilkan cabang kosong dan menolak batas tidak sah', () => {
  const source = recorder()
  source.recordMessage({ role: 'user', content: 'mulai' })
  source.recordMessage({ role: 'assistant', content: 'jawab' })

  const branch = forkSessionAt(source.id, 0)
  assert.deepEqual(branch.messages, [])
  assert.equal(branch.forkedAtMessage, 0)
  assert.equal(branch.title, '(tanpa judul)')
  assert.throws(() => forkSessionAt(source.id, -1), /antara 0 dan 2/)
  assert.throws(() => forkSessionAt(source.id, 3), /antara 0 dan 2/)
  assert.throws(() => forkSessionAt(source.id, 0.5), /antara 0 dan 2/)
})

test('daftar titik rewind menyembunyikan feedback hook internal', () => {
  const turns = sessionTurns([
    { role: 'user', content: 'prompt biasa' },
    { role: 'assistant', content: 'jawaban' },
    { role: 'user', content: '[Boo on_complete hook feedback]\nperbaiki lint' },
    { role: 'assistant', content: 'diperbaiki' },
    { role: 'user', content: '[Boo plan mode request]\nrancang cache' },
  ])
  assert.deepEqual(turns.map((turn) => ({ number: turn.number, messageIndex: turn.messageIndex, title: turn.title })), [
    { number: 1, messageIndex: 0, title: 'prompt biasa' },
    { number: 2, messageIndex: 4, title: '/plan rancang cache' },
  ])
})

function recorderWithMessage() {
  const session = recorder()
  session.recordMessage({ role: 'user', content: 'tanpa ringkasan' })
  return session
}
