import type { Tool } from '../domain/tool.ts'
import { addEventTrigger, describeEventTrigger, loadEventTriggers, removeEventTrigger } from '../automation/triggers.ts'

export const triggerListTool: Tool = {
  name: 'trigger_list', description: 'List durable local Boo event triggers for file changes, Git commits, custom events, and webhooks. Never reveals webhook token hashes.', risk: 'safe',
  schema: { type: 'function', function: { name: 'trigger_list', description: 'List local event triggers.', parameters: { type: 'object', properties: {} } } },
  preview: () => 'lihat event trigger',
  async run(_args, context) {
    const triggers = loadEventTriggers(context.home).triggers
    return { content: triggers.length ? triggers.map((trigger) => `- ${trigger.id.slice(0, 8)} · ${trigger.enabled ? 'aktif' : 'nonaktif'} · ${describeEventTrigger(trigger.source)} · runs ${trigger.runs}/${trigger.failures} gagal · ${trigger.prompt.slice(0, 160)}`).join('\n') : '(Belum ada event trigger.)' }
  },
}

interface AddArgs { prompt: string; source: 'file' | 'git' | 'custom'; pattern?: string; event?: string; debounce_ms?: number; full_auto?: boolean }
export const triggerAddTool: Tool<AddArgs> = {
  name: 'trigger_add', description: 'Create a durable local Boo event trigger for the current workspace. Supports file changes, Git commits, and named custom/CI events. Webhook creation is CLI-only so its one-time secret never enters model context. Requires fresh approval.', risk: 'confirm', allowAlways: false,
  schema: { type: 'function', function: { name: 'trigger_add', description: 'Create a local event trigger.', parameters: { type: 'object', properties: {
    prompt: { type: 'string', minLength: 1, maxLength: 32_000 },
    source: { type: 'string', enum: ['file', 'git', 'custom'] },
    pattern: { type: 'string', minLength: 1, maxLength: 512 },
    event: { type: 'string', minLength: 1, maxLength: 128 },
    debounce_ms: { type: 'integer', minimum: 0, maximum: 86_400_000 },
    full_auto: { type: 'boolean' },
  }, required: ['prompt', 'source'] } } },
  preview: (args) => `buat trigger ${args.source}: ${args.prompt.slice(0, 100)}`,
  async run(args, context) {
    try {
      const source = args.source === 'file'
        ? (typeof args.pattern === 'string' ? { kind: 'file' as const, pattern: args.pattern } : null)
        : args.source === 'custom'
          ? (typeof args.event === 'string' ? { kind: 'custom' as const, event: args.event } : null)
          : { kind: 'git' as const }
      if (!source) return { content: args.source === 'file' ? 'Trigger file membutuhkan pattern.' : 'Trigger custom membutuhkan event.', isError: true }
      const result = addEventTrigger({
        prompt: args.prompt, workspace: context.workspace, source, approval: args.full_auto ? 'workspace' : 'never',
        ...(args.debounce_ms === undefined ? {} : { debounceMs: args.debounce_ms }),
      }, context.home)
      return { content: `Trigger ${result.trigger.id.slice(0, 8)} dibuat untuk ${describeEventTrigger(result.trigger.source)}. Jalankan \`boo-code daemon\` agar trigger aktif.` }
    } catch (error) { return { content: `Gagal membuat trigger: ${error instanceof Error ? error.message : 'kesalahan tidak dikenal'}`, isError: true } }
  },
}

export const triggerRemoveTool: Tool<{ id: string }> = {
  name: 'trigger_remove', description: 'Remove one durable local event trigger. Requires fresh approval.', risk: 'confirm', allowAlways: false,
  schema: { type: 'function', function: { name: 'trigger_remove', description: 'Remove an event trigger by full id or unique prefix.', parameters: { type: 'object', properties: { id: { type: 'string', minLength: 4, maxLength: 64 } }, required: ['id'] } } },
  preview: (args) => `hapus event trigger ${args.id}`,
  async run(args, context) {
    const matches = loadEventTriggers(context.home).triggers.filter((trigger) => trigger.id.startsWith(args.id))
    if (matches.length !== 1) return { content: matches.length ? 'Prefix id ambigu; gunakan id lebih panjang.' : 'Event trigger tidak ditemukan.', isError: true }
    return removeEventTrigger(matches[0].id, context.home) ? { content: `Trigger ${matches[0].id.slice(0, 8)} dihapus.` } : { content: 'Event trigger tidak ditemukan.', isError: true }
  },
}
