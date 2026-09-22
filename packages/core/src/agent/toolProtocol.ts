/** Circuit breaker lokal untuk function-calling provider yang terus tidak valid. */

import type { Message, ToolCall } from '../domain/message.ts'

export const TOOL_PROTOCOL_GUARD_MARK = '[BOO TOOL PROTOCOL CIRCUIT BREAKER]'
export const TOOL_PROTOCOL_WARNING_TURNS = 2
export const TOOL_PROTOCOL_OPEN_TURNS = 3
export const MAX_TOOL_PROTOCOL_AUTO_FALLBACKS = 2
export const TOOL_PROTOCOL_STOPPED_REPLY = `(Dihentikan: model gagal menghasilkan function call valid selama ${TOOL_PROTOCOL_OPEN_TURNS} putaran berturut-turut.)`

export type ToolProtocolFailureKind = 'unknown-tool' | 'invalid-json' | 'invalid-schema' | 'empty-tool-call'
export type ToolProtocolAction = 'continue' | 'warning' | 'open'

export interface ToolProtocolDecision {
  action: ToolProtocolAction
  consecutiveTurns: number
  failures: number
  kinds: ToolProtocolFailureKind[]
}

/** Nama provider adalah metadata tak tepercaya; UI tidak perlu menerima kontrol atau teks panjang. */
export function toolProtocolName(value: unknown): string {
  if (typeof value !== 'string') return '(tanpa nama)'
  const clean = Array.from(value, (character) => {
    const code = character.charCodeAt(0)
    return code < 32 || (code >= 127 && code <= 159) ? ' ' : character
  }).join('').replace(/\s+/g, ' ').trim().slice(0, 100)
  return clean || '(tanpa nama)'
}

/**
 * Hanya putaran invalid murni yang menaikkan circuit. Satu call valid membuktikan
 * protokol masih bekerja dan mereset rangkaian, walau call lain dalam batch salah.
 */
export class ToolProtocolCircuitBreaker {
  private consecutiveTurns = 0
  private failures = 0
  private readonly kinds = new Set<ToolProtocolFailureKind>()

  recordTurn(failures: readonly ToolProtocolFailureKind[], validCalls: number): ToolProtocolDecision {
    if (validCalls > 0 || failures.length === 0) {
      this.reset()
      return { action: 'continue', consecutiveTurns: 0, failures: 0, kinds: [] }
    }
    this.consecutiveTurns += 1
    this.failures += failures.length
    failures.forEach((kind) => this.kinds.add(kind))
    const action: ToolProtocolAction = this.consecutiveTurns >= TOOL_PROTOCOL_OPEN_TURNS
      ? 'open'
      : this.consecutiveTurns >= TOOL_PROTOCOL_WARNING_TURNS ? 'warning' : 'continue'
    return {
      action,
      consecutiveTurns: this.consecutiveTurns,
      failures: this.failures,
      kinds: [...this.kinds],
    }
  }

  reset(): void {
    this.consecutiveTurns = 0
    this.failures = 0
    this.kinds.clear()
  }
}

export function toolProtocolSystemPrompt(decision: ToolProtocolDecision): string {
  const kinds = decision.kinds.join(', ') || 'invalid-tool-call'
  return `${TOOL_PROTOCOL_GUARD_MARK}\nThe local runtime observed ${decision.consecutiveTurns} consecutive model turns containing only invalid function calls (${kinds}). No invalid call was executed. Use only an exact tool name currently present in the supplied schemas and emit one complete JSON object matching that schema. If the capability is absent, call tool_search. Do not repeat or paraphrase the rejected payload, and do not claim any rejected tool ran.`
}

export function unknownToolFailure(name: string): string {
  return `${TOOL_PROTOCOL_GUARD_MARK}\nPanggilan tool ${JSON.stringify(toolProtocolName(name))} ditolak sebelum eksekusi karena nama tersebut tidak dikenal dalam katalog runtime. Gunakan hanya nama persis dari schema yang tersedia; panggil tool_search bila capability belum aktif.`
}

/** Tool call tanpa id atau dengan id duplikat diperbaiki sebelum masuk history. */
export function normalizeToolCallIds(message: Message, turn: number): Message {
  if (!message.tool_calls?.length) return message
  const used = new Set<string>()
  const calls: ToolCall[] = message.tool_calls.map((call, index) => {
    let id = typeof call.id === 'string' ? call.id.trim() : ''
    if (!id || used.has(id)) {
      const base = `call_boo_${Math.max(0, turn)}_${index}`
      id = base
      for (let suffix = 1; used.has(id); suffix += 1) id = `${base}_${suffix}`
    }
    used.add(id)
    return id === call.id ? call : { ...call, id }
  })
  return calls.every((call, index) => call === message.tool_calls?.[index]) ? message : { ...message, tool_calls: calls }
}
