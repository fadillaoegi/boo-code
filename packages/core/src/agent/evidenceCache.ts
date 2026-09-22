/** Cache bukti baca-saja yang hidup hanya selama satu task agent. */

import { createHash } from 'node:crypto'
import type { Message } from '../domain/message.ts'
import { protectToolResult } from '../security/promptInjection.ts'

export const EVIDENCE_CACHE_MARK = '[BOO EVIDENCE CACHE]'
const REFERENCE = /\[BOO EVIDENCE CACHE REF:([a-f0-9]{16})\]/g
const CACHEABLE_TOOLS = new Set(['read_file'])
const DEFAULT_MAX_ENTRIES = 64
const DEFAULT_MAX_CHARACTERS = 512_000

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? String(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`
}

function keyFor(name: string, args: Record<string, unknown>): string {
  return createHash('sha256').update(`${name}\n${canonical(args)}`).digest('hex')
}

export interface EvidenceCacheHit {
  ref: string
  preview: string
  content: string
  savedCharacters: number
}

interface EvidenceEntry {
  key: string
  ref: string
  tool: string
  preview: string
  sourceCallId: string
  content: string
}

export interface EvidenceHydration {
  messages: Message[]
  hydrated: number
}

/**
 * Tidak memakai DB dan tidak bertahan lintas task. Saat batas tercapai, cache
 * berhenti menerima entry baru alih-alih menggusur bukti yang referensinya sudah
 * berada di history.
 */
export class EvidenceCache {
  private readonly entries = new Map<string, EvidenceEntry>()
  private readonly refs = new Map<string, EvidenceEntry>()
  private readonly maxEntries: number
  private readonly maxCharacters: number
  private characters = 0

  constructor(options: { maxEntries?: number; maxCharacters?: number } = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES)
    this.maxCharacters = Math.max(1, options.maxCharacters ?? DEFAULT_MAX_CHARACTERS)
  }

  eligible(name: string): boolean {
    return CACHEABLE_TOOLS.has(name)
  }

  lookup(name: string, args: Record<string, unknown>): EvidenceCacheHit | null {
    if (!this.eligible(name)) return null
    const entry = this.entries.get(keyFor(name, args))
    if (!entry) return null
    const content = `[BOO EVIDENCE CACHE REF:${entry.ref}]\nHasil ${name} identik dipakai ulang dari bukti task yang masih valid. Jangan panggil ulang dengan argumen yang sama kecuali workspace berubah.`
    return { ref: entry.ref, preview: entry.preview, content, savedCharacters: Math.max(0, entry.content.length - content.length) }
  }

  store(name: string, args: Record<string, unknown>, sourceCallId: string, preview: string, content: string): string | null {
    if (!this.eligible(name) || !content || content.length > this.maxCharacters) return null
    const key = keyFor(name, args)
    const existing = this.entries.get(key)
    if (existing) return existing.ref
    if (this.entries.size >= this.maxEntries || this.characters + content.length > this.maxCharacters) return null
    const ref = key.slice(0, 16)
    const entry = { key, ref, tool: name, preview, sourceCallId, content }
    this.entries.set(key, entry)
    this.refs.set(ref, entry)
    this.characters += content.length
    return ref
  }

  invalidate(): void {
    this.entries.clear()
    this.refs.clear()
    this.characters = 0
  }

  /**
   * Reference kecil dipertahankan selama hasil sumber masih ikut request. Bila
   * trimming/compaction membuang sumbernya, reference terakhir dihidrasi kembali
   * dengan bukti penuh sebelum request dikirim ke provider.
   */
  hydrateReferences(messages: readonly Message[]): EvidenceHydration {
    const presentCalls = new Set(messages.filter((message) => message.role === 'tool' && message.tool_call_id).map((message) => message.tool_call_id!))
    let hydrated = 0
    const output = messages.map((message) => {
      if (message.role !== 'tool' || typeof message.content !== 'string') return { ...message }
      REFERENCE.lastIndex = 0
      const match = REFERENCE.exec(message.content)
      if (!match) return { ...message }
      const entry = this.refs.get(match[1])
      if (!entry || presentCalls.has(entry.sourceCallId)) return { ...message }
      hydrated += 1
      return { ...message, content: protectToolResult(entry.tool, entry.content) }
    })
    return { messages: output, hydrated }
  }
}
