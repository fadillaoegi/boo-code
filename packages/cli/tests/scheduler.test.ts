import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadSchedules } from '@boo/core'
import { runDaemon, runScheduleCommand } from '../src/scheduler.ts'

test('CLI schedule membuat, menonaktifkan, dan menghapus task tanpa DB', async () => {
  const home = mkdtempSync(join(tmpdir(), 'boo-cli-schedule-'))
  const workspace = mkdtempSync(join(tmpdir(), 'boo-cli-schedule-work-'))
  assert.equal(await runScheduleCommand(['add', '--every', '15m', '--workspace', workspace, '--', 'audit proyek'], home), 0)
  const job = loadSchedules(home).jobs[0]
  assert.equal(job.prompt, 'audit proyek')
  assert.equal(await runScheduleCommand(['disable', job.id.slice(0, 8)], home), 0)
  assert.equal(loadSchedules(home).jobs[0].enabled, false)
  assert.equal(await runScheduleCommand(['remove', job.id.slice(0, 8)], home), 0)
  assert.equal(loadSchedules(home).jobs.length, 0)
  assert.equal(await runDaemon(['--once'], home), 0)
})

test('CLI schedule menolak jadwal ambigu dan durasi tidak sah', async () => {
  const home = mkdtempSync(join(tmpdir(), 'boo-cli-schedule-'))
  assert.equal(await runScheduleCommand(['add', '--every', '0m', '--', 'audit'], home), 2)
  assert.equal(await runScheduleCommand(['add', '--every', '5m', '--daily', '09:00', '--', 'audit'], home), 2)
})
