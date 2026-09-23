import type { Tool } from '../domain/tool.ts'
import { addSchedule, describeSchedule, loadSchedules, removeSchedule, type JobSchedule } from '../automation/scheduler.ts'

function scheduleOf(args: { every_minutes?: number; daily_at?: string }): JobSchedule | null {
  if (typeof args.every_minutes === 'number' && Number.isInteger(args.every_minutes) && args.every_minutes >= 1 && args.every_minutes <= 525_600 && args.daily_at === undefined) {
    return { kind: 'interval', everyMinutes: args.every_minutes }
  }
  if (typeof args.daily_at === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(args.daily_at) && args.every_minutes === undefined) {
    return { kind: 'daily', time: args.daily_at }
  }
  return null
}

export const scheduleListTool: Tool = {
  name: 'schedule_list', description: 'List local Boo tasks scheduled for this device. Shows prompt summaries but never provider credentials.', risk: 'safe',
  schema: { type: 'function', function: { name: 'schedule_list', description: 'List durable local Boo schedules.', parameters: { type: 'object', properties: {} } } },
  preview: () => 'lihat task terjadwal',
  async run(_args, context) {
    const jobs = loadSchedules(context.home).jobs
    return { content: jobs.length ? jobs.map((job) => `- ${job.id.slice(0, 8)} · ${job.enabled ? 'aktif' : 'nonaktif'} · ${describeSchedule(job.schedule)} · berikutnya ${new Date(job.nextRunAt).toISOString()} · ${job.prompt.slice(0, 160)}`).join('\n') : '(Belum ada task terjadwal.)' }
  },
}

interface AddArgs { prompt: string; every_minutes?: number; daily_at?: string; full_auto?: boolean }
export const scheduleAddTool: Tool<AddArgs> = {
  name: 'schedule_add', description: 'Create a durable local scheduled Boo task for the current workspace. Requires fresh approval. full_auto only permits workspace changes and sandboxed local commands; external actions remain denied.', risk: 'confirm', allowAlways: false,
  schema: { type: 'function', function: { name: 'schedule_add', description: 'Schedule a Boo prompt at an interval or local daily time.', parameters: { type: 'object', properties: {
    prompt: { type: 'string', minLength: 1, maxLength: 32_000 },
    every_minutes: { type: 'integer', minimum: 1, maximum: 525_600 },
    daily_at: { type: 'string', pattern: '^(?:[01]\\d|2[0-3]):[0-5]\\d$' },
    full_auto: { type: 'boolean' },
  }, required: ['prompt'] } } },
  preview: (args) => `jadwalkan task: ${args.prompt.slice(0, 100)}`,
  async run(args, context) {
    const schedule = scheduleOf(args)
    if (!schedule) return { content: 'Pilih tepat satu jadwal: every_minutes atau daily_at (HH:MM).', isError: true }
    try {
      const job = addSchedule({ prompt: args.prompt, workspace: context.workspace, schedule, approval: args.full_auto ? 'workspace' : 'never' }, context.home)
      return { content: `Task ${job.id.slice(0, 8)} dijadwalkan ${describeSchedule(schedule)}. Jalankan \`boo-code daemon\` agar scheduler aktif.` }
    } catch (error) { return { content: `Gagal menjadwalkan task: ${error instanceof Error ? error.message : 'kesalahan tidak dikenal'}`, isError: true } }
  },
}

export const scheduleRemoveTool: Tool<{ id: string }> = {
  name: 'schedule_remove', description: 'Remove one durable local scheduled Boo task. Requires fresh approval.', risk: 'confirm', allowAlways: false,
  schema: { type: 'function', function: { name: 'schedule_remove', description: 'Remove a scheduled task by full id or unique prefix.', parameters: { type: 'object', properties: { id: { type: 'string', minLength: 4, maxLength: 64 } }, required: ['id'] } } },
  preview: (args) => `hapus task terjadwal ${args.id}`,
  async run(args, context) {
    const matches = loadSchedules(context.home).jobs.filter((job) => job.id.startsWith(args.id))
    if (matches.length !== 1) return { content: matches.length ? 'Prefix id ambigu; gunakan id lebih panjang.' : 'Task terjadwal tidak ditemukan.', isError: true }
    return removeSchedule(matches[0].id, context.home) ? { content: `Task ${matches[0].id.slice(0, 8)} dihapus.` } : { content: 'Task terjadwal tidak ditemukan.', isError: true }
  },
}
