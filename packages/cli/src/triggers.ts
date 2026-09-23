import { createServer, type Server } from 'node:http'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import {
  addEventTrigger,
  describeEventTrigger,
  enqueueCustomTrigger,
  enqueueWebhookTrigger,
  loadEventTriggers,
  parseTriggerDuration,
  removeEventTrigger,
  setEventTriggerEnabled,
} from '@boo/core'

export const DEFAULT_WEBHOOK_PORT = 7_331
const MAX_WEBHOOK_BODY_BYTES = 32 * 1024

export const TRIGGER_USAGE = `boo-code trigger — jalankan task Boo saat sebuah event terjadi

  boo-code trigger list
  boo-code trigger add file --pattern "src/**/*.ts" [--debounce 2s] -- <prompt>
  boo-code trigger add git [--debounce 2s] -- <prompt>
  boo-code trigger add custom --event build.failed -- <prompt>
  boo-code trigger add webhook -- <prompt>
  boo-code trigger emit build.failed
  boo-code trigger remove <id>
  boo-code trigger enable <id>
  boo-code trigger disable <id>

Opsi add: --workspace <path>, --full-auto, dan --debounce <ms|s|m|h>.
Webhook hanya mendengarkan loopback dan token rahasianya ditampilkan satu kali.
Jalankan boo-code daemon agar trigger aktif.`

function uniqueTrigger(prefix: string, home: string) {
  const matches = loadEventTriggers(home).triggers.filter((trigger) => trigger.id.startsWith(prefix))
  if (matches.length !== 1) throw new Error(matches.length ? 'Prefix id ambigu; gunakan id lebih panjang.' : 'Event trigger tidak ditemukan.')
  return matches[0]
}

function addArgs(args: readonly string[]): {
  source: { kind: 'file'; pattern: string } | { kind: 'git' } | { kind: 'custom'; event: string } | { kind: 'webhook' }
  prompt: string
  workspace: string
  fullAuto: boolean
  debounceMs?: number
} {
  const kind = args[0]
  if (!['file', 'git', 'custom', 'webhook'].includes(kind ?? '')) throw new Error('Jenis trigger harus file, git, custom, atau webhook.')
  let workspace = process.cwd()
  let fullAuto = false
  let pattern: string | undefined
  let event: string | undefined
  let debounceMs: number | undefined
  const prompt: string[] = []
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--') { prompt.push(...args.slice(index + 1)); break }
    if (arg === '--full-auto') { fullAuto = true; continue }
    if (arg === '--workspace' || arg === '--pattern' || arg === '--event' || arg === '--debounce') {
      const value = args[++index]
      if (!value) throw new Error(`${arg} membutuhkan nilai.`)
      if (arg === '--workspace') workspace = resolve(value)
      else if (arg === '--pattern') pattern = value
      else if (arg === '--event') event = value
      else {
        debounceMs = parseTriggerDuration(value) ?? undefined
        if (debounceMs === undefined) throw new Error('Durasi --debounce harus seperti 500ms, 2s, 5m, atau 1h (maksimal 24h).')
      }
      continue
    }
    if (arg.startsWith('-')) throw new Error(`Opsi trigger tidak dikenal: ${arg}`)
    prompt.push(arg)
  }
  const task = prompt.join(' ').trim()
  if (!task) throw new Error('Prompt task trigger belum diberikan.')
  let source: { kind: 'file'; pattern: string } | { kind: 'git' } | { kind: 'custom'; event: string } | { kind: 'webhook' }
  if (kind === 'file') {
    if (!pattern) throw new Error('Trigger file membutuhkan --pattern.')
    if (event) throw new Error('--event hanya berlaku untuk trigger custom.')
    source = { kind: 'file', pattern }
  } else if (kind === 'custom') {
    if (!event) throw new Error('Trigger custom membutuhkan --event.')
    if (pattern) throw new Error('--pattern hanya berlaku untuk trigger file.')
    source = { kind: 'custom', event }
  } else {
    if (pattern || event) throw new Error('--pattern hanya untuk file dan --event hanya untuk custom.')
    source = { kind: kind as 'git' | 'webhook' }
  }
  return { source, prompt: task, workspace, fullAuto, ...(debounceMs === undefined ? {} : { debounceMs }) }
}

export async function runTriggerCommand(args: readonly string[], home = homedir()): Promise<number> {
  const command = args[0] ?? 'list'
  try {
    if (command === '--help' || command === '-h' || command === 'help') { console.log(TRIGGER_USAGE); return 0 }
    if (command === 'list') {
      const triggers = loadEventTriggers(home).triggers
      if (!triggers.length) console.log('Belum ada event trigger.')
      for (const trigger of triggers) {
        console.log(`${trigger.id.slice(0, 8)}  ${trigger.enabled ? 'aktif   ' : 'nonaktif'}  ${describeEventTrigger(trigger.source)}  debounce=${trigger.debounceMs}ms  runs=${trigger.runs}/${trigger.failures} gagal\n  ${trigger.workspace}\n  ${trigger.prompt.slice(0, 240)}`)
      }
      return 0
    }
    if (command === 'add') {
      const parsed = addArgs(args.slice(1))
      const created = addEventTrigger({
        prompt: parsed.prompt, workspace: parsed.workspace, source: parsed.source,
        approval: parsed.fullAuto ? 'workspace' : 'never', ...(parsed.debounceMs === undefined ? {} : { debounceMs: parsed.debounceMs }),
      }, home)
      console.log(`Trigger ${created.trigger.id.slice(0, 8)} dibuat · ${describeEventTrigger(created.trigger.source)}`)
      if (created.webhookToken) {
        console.log(`URL: http://127.0.0.1:${DEFAULT_WEBHOOK_PORT}/v1/triggers/${created.trigger.id}`)
        console.log(`Token (hanya ditampilkan sekali): ${created.webhookToken}`)
        console.log('Kirim POST dengan header Authorization: Bearer <token>. Payload diabaikan demi keamanan.')
      }
      console.log('Jalankan `boo-code daemon` agar trigger aktif.')
      return 0
    }
    if (command === 'emit') {
      const event = args[1]
      if (!event || args.length !== 2) throw new Error('trigger emit membutuhkan tepat satu nama event.')
      const count = enqueueCustomTrigger(event, home)
      console.log(count ? `Event ${event} diantrikan untuk ${count} trigger.` : `Tidak ada trigger aktif untuk event ${event}.`)
      return count ? 0 : 1
    }
    if (command === 'remove' || command === 'enable' || command === 'disable') {
      const prefix = args[1]
      if (!prefix) throw new Error(`${command} membutuhkan id trigger.`)
      const trigger = uniqueTrigger(prefix, home)
      if (command === 'remove') removeEventTrigger(trigger.id, home)
      else setEventTriggerEnabled(trigger.id, command === 'enable', home)
      console.log(`Trigger ${trigger.id.slice(0, 8)} ${command === 'remove' ? 'dihapus' : command === 'enable' ? 'diaktifkan' : 'dinonaktifkan'}.`)
      return 0
    }
    throw new Error(`Subcommand trigger tidak dikenal: ${command}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Perintah trigger gagal.')
    console.error('Pakai `boo-code trigger --help` untuk bantuan.')
    return 2
  }
}

function bearer(value: string | undefined): string {
  const match = /^Bearer\s+(.+)$/i.exec(value ?? '')
  return match?.[1] ?? ''
}

/** Local-only HTTP ingress. External reverse proxies must provide their own TLS and access controls. */
export async function startTriggerWebhookServer(home = homedir(), port = DEFAULT_WEBHOOK_PORT): Promise<{ server: Server; port: number; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json; charset=utf-8')
    const match = /^\/v1\/triggers\/([a-f0-9-]{8,64})$/.exec(new URL(request.url ?? '/', 'http://127.0.0.1').pathname)
    if (request.method !== 'POST' || !match) { response.writeHead(404); response.end('{"error":"not_found"}\n'); return }
    let bytes = 0
    let oversized = false
    request.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > MAX_WEBHOOK_BODY_BYTES) oversized = true
    })
    request.on('end', () => {
      if (oversized) { response.writeHead(413); response.end('{"error":"payload_too_large"}\n'); return }
      if (!enqueueWebhookTrigger(match[1], bearer(request.headers.authorization), home)) {
        response.writeHead(401); response.end('{"error":"unauthorized"}\n'); return
      }
      response.writeHead(202); response.end('{"queued":true}\n')
    })
  })
  await new Promise<void>((resolvePromise, reject) => {
    const onError = (error: Error) => { server.off('listening', onListening); reject(error) }
    const onListening = () => { server.off('error', onError); resolvePromise() }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, '127.0.0.1')
  })
  const address = server.address()
  const actualPort = typeof address === 'object' && address ? address.port : port
  return {
    server, port: actualPort,
    close: () => new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise())),
  }
}
