import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireSchedulerLock, addSchedule, claimDueSchedules, finishScheduleRun, loadSchedules, nextRun, parseScheduleDuration, removeSchedule, SCHEDULE_RUNS_FILE } from '../src/automation/scheduler.ts'

test('scheduler menyimpan interval secara privat dan claim mencegah run ganda', () => {
  const home = mkdtempSync(join(tmpdir(), 'boo-scheduler-'))
  const job = addSchedule({ prompt: 'periksa test', workspace: '/workspace', schedule: { kind: 'interval', everyMinutes: 5 }, now: 1_000 }, home)
  assert.equal(loadSchedules(home).jobs[0].nextRunAt, 301_000)
  assert.deepEqual(claimDueSchedules(home, 300_000), [])
  assert.equal(claimDueSchedules(home, 301_000)[0].id, job.id)
  assert.deepEqual(claimDueSchedules(home, 301_000), [])
  finishScheduleRun(job.id, 1, 301_000, home, 302_000)
  const updated = loadSchedules(home).jobs[0]
  assert.equal(updated.runs, 1)
  assert.equal(updated.failures, 1)
  assert.equal(statSync(join(home, '.boo', 'schedules.json')).mode & 0o777, 0o600)
  assert.match(readFileSync(join(home, '.boo', SCHEDULE_RUNS_FILE), 'utf8'), new RegExp(job.id))
})

test('scheduler mendukung waktu harian, durasi CLI, remove, dan lock tunggal', () => {
  const home = mkdtempSync(join(tmpdir(), 'boo-scheduler-'))
  const after = new Date(2026, 0, 1, 10, 0, 0).getTime()
  assert.equal(new Date(nextRun({ kind: 'daily', time: '11:30' }, after)).getHours(), 11)
  assert.equal(parseScheduleDuration('2h'), 120)
  assert.equal(parseScheduleDuration('0m'), null)
  const job = addSchedule({ prompt: 'audit', workspace: '/workspace', schedule: { kind: 'daily', time: '09:00' }, now: after }, home)
  const release = acquireSchedulerLock(home)
  assert.throws(() => acquireSchedulerLock(home), /sudah berjalan/)
  release()
  writeFileSync(join(home, '.boo', 'scheduler.lock'), '999999999\n')
  const recovered = acquireSchedulerLock(home)
  recovered()
  assert.equal(removeSchedule(job.id, home), true)
  assert.equal(loadSchedules(home).jobs.length, 0)
})
