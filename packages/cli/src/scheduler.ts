import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { acquireSchedulerLock, addSchedule, claimDueSchedules, claimEventTriggers, describeSchedule, finishEventTriggerRun, finishScheduleRun, loadSchedules, parseScheduleDuration, removeSchedule, setScheduleEnabled, triggeredPrompt, type JobSchedule } from '@boo/core'
import { runExec } from './exec.ts'
import { DEFAULT_WEBHOOK_PORT, startTriggerWebhookServer } from './triggers.ts'

export const SCHEDULE_USAGE = `boo-code schedule — kelola task agent terjadwal lokal

  boo-code schedule list
  boo-code schedule add --every 30m -- <prompt>
  boo-code schedule add --daily 09:00 --full-auto -- <prompt>
  boo-code schedule remove <id>
  boo-code schedule enable <id>
  boo-code schedule disable <id>
  boo-code daemon [--once] [--webhook-port 7331] [--no-webhook]

--full-auto hanya mengizinkan perubahan workspace dan command lokal dalam sandbox.
Aksi eksternal, computer use, pesan, MCP, dan credential tetap tidak disetujui.`

function uniqueJob(prefix: string, home: string) {
  const matches = loadSchedules(home).jobs.filter((job) => job.id.startsWith(prefix))
  if (matches.length !== 1) throw new Error(matches.length ? 'Prefix id ambigu; gunakan id lebih panjang.' : 'Task terjadwal tidak ditemukan.')
  return matches[0]
}

function scheduleArgs(args: readonly string[]): { schedule: JobSchedule; prompt: string; workspace: string; fullAuto: boolean } {
  let schedule: JobSchedule | null = null
  let workspace = process.cwd()
  let fullAuto = false
  const prompt: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--') { prompt.push(...args.slice(index + 1)); break }
    if (arg === '--full-auto') { fullAuto = true; continue }
    if (arg === '--every' || arg === '--daily' || arg === '--workspace') {
      const value = args[++index]
      if (!value) throw new Error(`${arg} membutuhkan nilai.`)
      if (arg === '--workspace') workspace = resolve(value)
      else if (arg === '--every') {
        const minutes = parseScheduleDuration(value)
        if (!minutes) throw new Error('Durasi --every harus seperti 15m, 2h, atau 1d.')
        if (schedule) throw new Error('Pilih salah satu --every atau --daily.')
        schedule = { kind: 'interval', everyMinutes: minutes }
      } else {
        if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error('Waktu --daily harus HH:MM (waktu lokal).')
        if (schedule) throw new Error('Pilih salah satu --every atau --daily.')
        schedule = { kind: 'daily', time: value }
      }
      continue
    }
    if (arg.startsWith('-')) throw new Error(`Opsi schedule tidak dikenal: ${arg}`)
    prompt.push(arg)
  }
  if (!schedule) throw new Error('Berikan --every atau --daily.')
  if (!prompt.join(' ').trim()) throw new Error('Prompt task terjadwal belum diberikan.')
  return { schedule, prompt: prompt.join(' ').trim(), workspace, fullAuto }
}

export async function runScheduleCommand(args: readonly string[], home = homedir()): Promise<number> {
  const command = args[0] ?? 'list'
  try {
    if (command === '--help' || command === '-h' || command === 'help') { console.log(SCHEDULE_USAGE); return 0 }
    if (command === 'list') {
      const jobs = loadSchedules(home).jobs
      if (!jobs.length) console.log('Belum ada task terjadwal.')
      for (const job of jobs) console.log(`${job.id.slice(0, 8)}  ${job.enabled ? 'aktif   ' : 'nonaktif'}  ${describeSchedule(job.schedule)}  next=${new Date(job.nextRunAt).toISOString()}  runs=${job.runs}/${job.failures} gagal\n  ${job.workspace}\n  ${job.prompt.slice(0, 240)}`)
      return 0
    }
    if (command === 'add') {
      const parsed = scheduleArgs(args.slice(1))
      const job = addSchedule({ prompt: parsed.prompt, workspace: parsed.workspace, schedule: parsed.schedule, approval: parsed.fullAuto ? 'workspace' : 'never' }, home)
      console.log(`Task ${job.id.slice(0, 8)} dibuat · ${describeSchedule(job.schedule)} · next ${new Date(job.nextRunAt).toISOString()}`)
      console.log('Jalankan `boo-code daemon` agar scheduler aktif.')
      return 0
    }
    if (command === 'remove' || command === 'enable' || command === 'disable') {
      const prefix = args[1]
      if (!prefix) throw new Error(`${command} membutuhkan id task.`)
      const job = uniqueJob(prefix, home)
      if (command === 'remove') removeSchedule(job.id, home)
      else setScheduleEnabled(job.id, command === 'enable', home)
      console.log(`Task ${job.id.slice(0, 8)} ${command === 'remove' ? 'dihapus' : command === 'enable' ? 'diaktifkan' : 'dinonaktifkan'}.`)
      return 0
    }
    throw new Error(`Subcommand schedule tidak dikenal: ${command}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Perintah schedule gagal.')
    console.error('Pakai `boo-code schedule --help` untuk bantuan.')
    return 2
  }
}

async function runDue(home: string): Promise<number> {
  const jobs = claimDueSchedules(home, Date.now(), 10)
  for (const job of jobs) {
    const startedAt = Date.now()
    console.log(`[scheduler] menjalankan ${job.id.slice(0, 8)} di ${job.workspace}`)
    let exitCode = 1
    try {
      exitCode = await runExec(['--ephemeral', '--json', '--approval', job.approval, job.prompt], job.workspace)
    } catch (error) {
      console.error(`[scheduler] ${job.id.slice(0, 8)} gagal: ${error instanceof Error ? error.message : 'kesalahan tidak dikenal'}`)
    }
    finishScheduleRun(job.id, exitCode, startedAt, home)
    console.log(`[scheduler] ${job.id.slice(0, 8)} selesai exit=${exitCode}`)
  }
  return jobs.length
}

async function runTriggered(home: string): Promise<number> {
  const dispatches = await claimEventTriggers(home, Date.now(), 10)
  for (const dispatch of dispatches) {
    const startedAt = Date.now()
    console.log(`[trigger] menjalankan ${dispatch.trigger.id.slice(0, 8)} (${dispatch.reason}) di ${dispatch.trigger.workspace}`)
    let exitCode = 1
    try {
      exitCode = await runExec(['--ephemeral', '--json', '--approval', dispatch.trigger.approval, triggeredPrompt(dispatch)], dispatch.trigger.workspace)
    } catch (error) {
      console.error(`[trigger] ${dispatch.trigger.id.slice(0, 8)} gagal: ${error instanceof Error ? error.message : 'kesalahan tidak dikenal'}`)
    }
    finishEventTriggerRun(dispatch.trigger.id, exitCode, startedAt, home)
    console.log(`[trigger] ${dispatch.trigger.id.slice(0, 8)} selesai exit=${exitCode}`)
  }
  return dispatches.length
}

async function runAutomationDue(home: string): Promise<number> {
  return (await runDue(home)) + (await runTriggered(home))
}

function daemonArgs(args: readonly string[]): { once: boolean; webhook: boolean; webhookPort: number } {
  let once = false
  let webhook = true
  let webhookPort = DEFAULT_WEBHOOK_PORT
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--once') once = true
    else if (arg === '--no-webhook') webhook = false
    else if (arg === '--webhook-port') {
      const value = Number(args[++index])
      if (!Number.isInteger(value) || value < 1 || value > 65_535) throw new Error('--webhook-port harus berupa angka 1–65535.')
      webhookPort = value
    } else throw new Error(`Opsi daemon tidak dikenal: ${arg}`)
  }
  return { once, webhook, webhookPort }
}

export async function runDaemon(args: readonly string[], home = homedir()): Promise<number> {
  let options: ReturnType<typeof daemonArgs>
  try { options = daemonArgs(args) } catch (error) {
    console.error(error instanceof Error ? error.message : 'Opsi daemon tidak sah.')
    console.error(SCHEDULE_USAGE)
    return 2
  }
  let release: () => void
  try { release = acquireSchedulerLock(home) } catch (error) {
    console.error(error instanceof Error ? error.message : 'Scheduler tidak dapat dikunci.')
    return 1
  }
  let closeWebhook: (() => Promise<void>) | undefined
  try {
    if (options.once) { await runAutomationDue(home); return 0 }
    if (options.webhook) {
      try {
        const webhook = await startTriggerWebhookServer(home, options.webhookPort)
        closeWebhook = webhook.close
        console.log(`Webhook trigger lokal aktif · http://127.0.0.1:${webhook.port}`)
      } catch (error) {
        console.error(`Webhook trigger gagal dimulai: ${error instanceof Error ? error.message : 'kesalahan tidak dikenal'}`)
        return 1
      }
    }
    console.log('Boo automation daemon aktif · polling 2 detik · Ctrl-C untuk berhenti')
    await runAutomationDue(home)
    await new Promise<void>((resolvePromise) => {
      let running = false
      let active: Promise<void> = Promise.resolve()
      const tick = () => {
        if (running) return
        running = true
        active = runAutomationDue(home)
          .then(() => undefined)
          .catch((error) => { console.error(`[scheduler] tick gagal: ${error instanceof Error ? error.message : 'kesalahan tidak dikenal'}`) })
          .finally(() => { running = false })
      }
      const timer = setInterval(tick, 2_000)
      const stop = () => {
        clearInterval(timer)
        void active.finally(resolvePromise)
      }
      process.once('SIGINT', stop)
      process.once('SIGTERM', stop)
    })
    return 0
  } finally {
    if (closeWebhook) await closeWebhook().catch(() => undefined)
    release()
  }
}
