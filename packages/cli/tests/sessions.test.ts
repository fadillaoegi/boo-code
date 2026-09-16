import assert from 'node:assert/strict'
import test from 'node:test'
import { appendFileSync, existsSync, mkdtempSync, readdirSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// HOME dialihkan sebelum modul dimuat, karena lokasi sesi dihitung saat impor.
// Sesi asli pengguna di ~/.boo tidak boleh tersentuh oleh tes.
const fakeHome = mkdtempSync(join(tmpdir(), 'boo-home-'))
process.env.HOME = fakeHome
const sessions = await import('../src/sessions.ts')
const { SessionRecorder, SessionError, listSessions, loadSession, resolveSessionId, SESSIONS_DIR } = sessions

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

test('model yang dipilih sebelum pesan pertama ikut tersimpan', () => {
  const session = recorder()
  session.recordModel('cx/gpt-5.6-luna', 'medium')
  session.recordMessage({ role: 'user', content: 'halo' })
  const loaded = loadSession(session.id)
  assert.equal(loaded.model, 'cx/gpt-5.6-luna')
  assert.equal(loaded.reasoningEffort, 'medium')
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
