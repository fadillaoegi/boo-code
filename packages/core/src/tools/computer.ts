/**
 * Computer-use lintas platform melalui bridge accessibility milik pengguna.
 *
 * Core tidak menjalankan AppleScript/PowerShell/xdotool dari argumen model. Satu
 * executable absolut didaftarkan pengguna di ~/.boo/computer.json dan menerima
 * request JSON melalui stdin. Implementasi bridge boleh memakai macOS
 * Accessibility, Windows UI Automation, atau Linux AT-SPI. Kontrak yang sama
 * membuat approval, batas data, dan referensi elemen konsisten di semua OS.
 */

import { spawn } from 'node:child_process'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, sep } from 'node:path'
import type { Tool } from '../domain/tool.ts'
import { redactSensitiveText } from '../security/redaction.ts'
import { commandEnvironment } from './commandEnvironment.ts'

export type ComputerPlatform = 'darwin' | 'win32' | 'linux'
export type ComputerAction = 'status' | 'snapshot' | 'click' | 'type' | 'press'

export interface ComputerBridgeDefinition {
  command: string
  args: string[]
  platform: ComputerPlatform
}

export interface ComputerElement {
  ref: string
  role: string
  name: string
  value?: string
  enabled?: boolean
}

export interface ComputerResponse {
  ok: boolean
  message: string
  app?: string
  elements?: ComputerElement[]
}

interface ComputerRequest {
  version: 1
  action: ComputerAction
  ref?: string
  text?: string
  key?: ComputerKey
  maxElements?: number
}

export type ComputerKey = 'Enter' | 'Escape' | 'Tab' | 'Space' | 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'Backspace' | 'Delete'

export const COMPUTER_CONFIG_PATH = join('.boo', 'computer.json')
export const COMPUTER_PROTOCOL_VERSION = 1
export const MAX_COMPUTER_ELEMENTS = 500
const MAX_CONFIG_BYTES = 64 * 1024
const MAX_OUTPUT_BYTES = 1024 * 1024
const MAX_TEXT_LENGTH = 4_000
const REQUEST_TIMEOUT_MS = 15_000
const REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const KEYS = new Set<ComputerKey>(['Enter', 'Escape', 'Tab', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backspace', 'Delete'])

function cleanText(value: unknown, limit = 500): string {
  if (typeof value !== 'string') return ''
  return Array.from(value, (character) => {
    const code = character.charCodeAt(0)
    return code === 9 || code === 10 || code >= 32 && code !== 127 ? character : '�'
  }).join('').slice(0, limit)
}

function platformOf(value: NodeJS.Platform): ComputerPlatform | null {
  return value === 'darwin' || value === 'win32' || value === 'linux' ? value : null
}

function parseBridge(value: unknown, platform: ComputerPlatform): ComputerBridgeDefinition | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as { command?: unknown; args?: unknown }
  if (typeof record.command !== 'string' || !isAbsolute(record.command) || /[\r\n\0]/.test(record.command)) return null
  if (record.args !== undefined && (!Array.isArray(record.args) || record.args.some((arg) => typeof arg !== 'string' || /[\r\n\0]/.test(arg)))) return null
  return { command: record.command, args: (record.args as string[] | undefined) ?? [], platform }
}

/** Konfigurasi global saja; repository tidak boleh mendaftarkan executable UI. */
export function loadComputerBridge(home = homedir(), platform: NodeJS.Platform = process.platform): ComputerBridgeDefinition | null {
  const supported = platformOf(platform)
  if (!supported) return null
  const root = join(home, '.boo')
  const path = join(root, 'computer.json')
  try {
    const real = realpathSync(path)
    const info = statSync(real)
    if (!info.isFile() || info.size > MAX_CONFIG_BYTES || !real.startsWith(`${realpathSync(root)}${sep}`)) return null
    const parsed = JSON.parse(readFileSync(real, 'utf8')) as { version?: unknown; bridges?: unknown }
    if (parsed.version !== COMPUTER_PROTOCOL_VERSION || !parsed.bridges || typeof parsed.bridges !== 'object' || Array.isArray(parsed.bridges)) return null
    return parseBridge((parsed.bridges as Record<string, unknown>)[supported], supported)
  } catch {
    return null
  }
}

function parseResponse(raw: string): ComputerResponse {
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw new Error('Bridge computer mengembalikan JSON yang tidak valid.') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Respons bridge computer tidak sah.')
  const record = parsed as { ok?: unknown; message?: unknown; app?: unknown; elements?: unknown }
  if (typeof record.ok !== 'boolean') throw new Error('Respons bridge computer tidak memiliki status.')
  const response: ComputerResponse = { ok: record.ok, message: cleanText(record.message, 2_000) || (record.ok ? 'Selesai.' : 'Bridge menolak tindakan.') }
  const app = cleanText(record.app, 240)
  if (app) response.app = app
  if (record.elements !== undefined) {
    if (!Array.isArray(record.elements)) throw new Error('Daftar elemen bridge computer tidak sah.')
    response.elements = record.elements.slice(0, MAX_COMPUTER_ELEMENTS).flatMap((item): ComputerElement[] => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return []
      const element = item as { ref?: unknown; role?: unknown; name?: unknown; value?: unknown; enabled?: unknown }
      if (typeof element.ref !== 'string' || !REF.test(element.ref)) return []
      const role = cleanText(element.role, 120)
      const name = cleanText(element.name, 500)
      if (!role) return []
      return [{ ref: element.ref, role, name, ...(typeof element.value === 'string' ? { value: cleanText(element.value, 500) } : {}), ...(typeof element.enabled === 'boolean' ? { enabled: element.enabled } : {}) }]
    })
  }
  return response
}

/** Menjalankan satu request tanpa shell dan tanpa mewariskan credential provider. */
export async function callComputerBridge(
  bridge: ComputerBridgeDefinition,
  request: ComputerRequest,
  signal?: AbortSignal,
): Promise<ComputerResponse> {
  const payload = `${JSON.stringify(request)}\n`
  return new Promise((resolve, reject) => {
    const child = spawn(bridge.command, bridge.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: commandEnvironment(),
    })
    let output = ''
    let errorOutput = ''
    let settled = false
    const finish = (error?: Error, response?: ComputerResponse) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolve(response!)
    }
    const abort = () => { child.kill(); finish(new Error('Computer use dibatalkan.')) }
    const timer = setTimeout(() => { child.kill(); finish(new Error('Bridge computer melewati batas waktu 15 detik.')) }, REQUEST_TIMEOUT_MS)
    signal?.addEventListener('abort', abort, { once: true })
    child.once('error', (error) => finish(new Error(`Bridge computer gagal dimulai: ${error.message}`)))
    child.stdout?.on('data', (chunk: Buffer | string) => {
      output += chunk.toString()
      if (Buffer.byteLength(output) > MAX_OUTPUT_BYTES) { child.kill(); finish(new Error('Respons bridge computer terlalu besar.')) }
    })
    child.stderr?.on('data', (chunk: Buffer | string) => { errorOutput = (errorOutput + chunk.toString()).slice(-4_000) })
    child.once('close', (code) => {
      if (settled) return
      if (code !== 0) return finish(new Error(`Bridge computer berhenti (exit ${code ?? '?'}). ${cleanText(errorOutput, 1_000)}`.trim()))
      try { finish(undefined, parseResponse(output.trim())) } catch (error) { finish(error instanceof Error ? error : new Error('Respons bridge computer tidak sah.')) }
    })
    child.stdin?.end(payload)
  })
}

function bridgeOrError(home?: string): ComputerBridgeDefinition | string {
  return loadComputerBridge(home) ?? `Computer use belum dikonfigurasi untuk ${process.platform}. Daftarkan bridge native absolut di ~/.boo/computer.json.`
}

function renderResponse(response: ComputerResponse): string {
  const header = `${response.ok ? 'OK' : 'Gagal'}: ${response.message}${response.app ? `\nAplikasi aktif: ${response.app}` : ''}`
  if (!response.elements?.length) return header
  const rows = response.elements.map((element) => `- ${element.ref} · ${element.role} · ${element.name || '(tanpa label)'}${element.enabled === false ? ' · disabled' : ''}${element.value ? ` · nilai: ${element.value}` : ''}`)
  return `${header}\nElemen (${response.elements.length}):\n${rows.join('\n')}`
}

async function run(request: ComputerRequest, home?: string, signal?: AbortSignal) {
  const bridge = bridgeOrError(home)
  if (typeof bridge === 'string') return { content: bridge, isError: true }
  try {
    const response = await callComputerBridge(bridge, request, signal)
    return { content: renderResponse(response), isError: !response.ok }
  } catch (error) {
    return { content: `Computer use gagal: ${error instanceof Error ? error.message : 'kesalahan tidak dikenal'}`, isError: true }
  }
}

const STATUS_DESCRIPTION = 'Check whether the user-configured native accessibility bridge is ready. Does not read screen or UI content.'
const SNAPSHOT_DESCRIPTION = 'Read a bounded accessibility snapshot of the active native application. Returns opaque element refs for later actions. Always requires fresh approval.'

export const computerStatusTool: Tool = {
  name: 'computer_status', description: STATUS_DESCRIPTION, risk: 'safe',
  schema: { type: 'function', function: { name: 'computer_status', description: STATUS_DESCRIPTION, parameters: { type: 'object', properties: {} } } },
  preview: () => 'cek bridge computer use',
  async run(_args, context) { return run({ version: 1, action: 'status' }, context.home, context.signal) },
}

export const computerSnapshotTool: Tool<{ max_elements?: number }> = {
  name: 'computer_snapshot', description: SNAPSHOT_DESCRIPTION, risk: 'confirm', allowAlways: false,
  schema: { type: 'function', function: { name: 'computer_snapshot', description: SNAPSHOT_DESCRIPTION, parameters: { type: 'object', properties: { max_elements: { type: 'integer', minimum: 1, maximum: MAX_COMPUTER_ELEMENTS } } } } },
  preview: () => 'baca UI aplikasi aktif',
  async run(args, context) {
    const maxElements = typeof args.max_elements === 'number' ? Math.max(1, Math.min(MAX_COMPUTER_ELEMENTS, Math.floor(args.max_elements))) : 200
    return run({ version: 1, action: 'snapshot', maxElements }, context.home, context.signal)
  },
}

interface RefArgs { ref: string }
interface TypeArgs extends RefArgs { text: string }
interface PressArgs extends RefArgs { key: ComputerKey }

export const computerClickTool: Tool<RefArgs> = {
  name: 'computer_click', description: 'Activate one native UI element by an opaque ref from the latest computer_snapshot. Coordinates and arbitrary selectors are not accepted.', risk: 'confirm', allowAlways: false,
  schema: { type: 'function', function: { name: 'computer_click', description: 'Activate one native UI element from the latest approved snapshot.', parameters: { type: 'object', properties: { ref: { type: 'string', pattern: REF.source } }, required: ['ref'] } } },
  preview: (args) => `klik elemen UI ${args.ref}`,
  async run(args, context) {
    if (!REF.test(args.ref)) return { content: 'Referensi elemen UI tidak sah. Ambil computer_snapshot baru.', isError: true }
    return run({ version: 1, action: 'click', ref: args.ref }, context.home, context.signal)
  },
}

export const computerTypeTool: Tool<TypeArgs> = {
  name: 'computer_type', description: 'Type visible non-secret text into one native UI element from the latest snapshot. Passwords, tokens, payment data, and OTP must never be supplied.', risk: 'confirm', allowAlways: false,
  schema: { type: 'function', function: { name: 'computer_type', description: 'Type visible non-secret text into a native UI element after fresh approval.', parameters: { type: 'object', properties: { ref: { type: 'string', pattern: REF.source }, text: { type: 'string', minLength: 1, maxLength: MAX_TEXT_LENGTH } }, required: ['ref', 'text'] } } },
  preview: (args) => `ketik ke elemen UI ${args.ref}`,
  async run(args, context) {
    if (!REF.test(args.ref) || !args.text || args.text.length > MAX_TEXT_LENGTH || args.text.includes('\0')) return { content: 'Referensi atau teks computer use tidak sah.', isError: true }
    if (redactSensitiveText(args.text, { environment: process.env }).redactions) return { content: 'Computer use menolak mengetik teks yang tampak seperti credential atau secret.', isError: true }
    return run({ version: 1, action: 'type', ref: args.ref, text: args.text }, context.home, context.signal)
  },
}

export const computerPressTool: Tool<PressArgs> = {
  name: 'computer_press', description: 'Press one navigation key on a native UI element from the latest snapshot. Arbitrary shortcuts are not accepted.', risk: 'confirm', allowAlways: false,
  schema: { type: 'function', function: { name: 'computer_press', description: 'Press one allowlisted key on a native UI element after fresh approval.', parameters: { type: 'object', properties: { ref: { type: 'string', pattern: REF.source }, key: { type: 'string', enum: [...KEYS] } }, required: ['ref', 'key'] } } },
  preview: (args) => `tekan ${args.key} pada elemen UI ${args.ref}`,
  async run(args, context) {
    if (!REF.test(args.ref) || !KEYS.has(args.key)) return { content: 'Referensi atau tombol computer use tidak sah.', isError: true }
    return run({ version: 1, action: 'press', ref: args.ref, key: args.key }, context.home, context.signal)
  },
}
