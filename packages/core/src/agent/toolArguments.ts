/** Validasi lokal argumen function calling sebelum preview, approval, atau side effect. */

import type { ToolSchema } from '../domain/message.ts'

export const TOOL_ARGUMENT_GUARD_MARK = '[BOO TOOL ARGUMENT GUARD]'
const MAX_ISSUES = 8
const MAX_DEPTH = 12

type SchemaNode = {
  type?: unknown
  properties?: unknown
  required?: unknown
  items?: unknown
  enum?: unknown
  minimum?: unknown
  maximum?: unknown
  minItems?: unknown
  maxItems?: unknown
  pattern?: unknown
  additionalProperties?: unknown
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function propertyPath(path: string, key: string): string {
  const clean = Array.from(key, (character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127 ? '' : character
  }).join('').slice(0, 80)
  return /^[A-Za-z_$][\w$-]*$/.test(key)
    ? `${path}.${key}`
    : `${path}[${JSON.stringify(clean)}]`
}

function typeLabel(type: string): string {
  return ({ object: 'objek', array: 'array', string: 'string', number: 'angka', integer: 'bilangan bulat', boolean: 'boolean', null: 'null' } as Record<string, string>)[type] ?? type
}

function matchesType(value: unknown, type: string): boolean {
  if (type === 'object') return object(value)
  if (type === 'array') return Array.isArray(value)
  if (type === 'integer') return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  if (type === 'null') return value === null
  return typeof value === type
}

/**
 * Subset JSON Schema yang dipakai seluruh tool bawaan Boo. Hasil hanya memuat
 * path dan aturan schema, tidak pernah nilai argumen model.
 */
export function validateToolArguments(parameters: ToolSchema['function']['parameters'], value: unknown): string[] {
  const issues: string[] = []
  let omitted = 0
  const add = (issue: string) => {
    if (issues.length < MAX_ISSUES) issues.push(issue)
    else omitted += 1
  }

  const visit = (schema: SchemaNode, current: unknown, path: string, depth: number): void => {
    if (depth > MAX_DEPTH) {
      add(`${path}: struktur argumen terlalu dalam`)
      return
    }
    const expected = typeof schema.type === 'string' ? schema.type : undefined
    if (expected && !matchesType(current, expected)) {
      add(`${path}: harus berupa ${typeLabel(expected)}`)
      return
    }

    if (Array.isArray(schema.enum) && !schema.enum.some((entry) => Object.is(entry, current))) {
      add(`${path}: harus salah satu dari ${schema.enum.map((entry) => JSON.stringify(entry)).join(', ')}`)
    }
    if (typeof current === 'number') {
      if (typeof schema.minimum === 'number' && current < schema.minimum) add(`${path}: minimum ${schema.minimum}`)
      if (typeof schema.maximum === 'number' && current > schema.maximum) add(`${path}: maksimum ${schema.maximum}`)
    }
    if (typeof current === 'string' && typeof schema.pattern === 'string') {
      try {
        if (!new RegExp(schema.pattern).test(current)) add(`${path}: format tidak sesuai pola ${schema.pattern}`)
      } catch {
        add(`${path}: schema pola internal tidak valid`)
      }
    }
    if (Array.isArray(current)) {
      if (typeof schema.minItems === 'number' && current.length < schema.minItems) add(`${path}: minimal ${schema.minItems} item`)
      if (typeof schema.maxItems === 'number' && current.length > schema.maxItems) add(`${path}: maksimal ${schema.maxItems} item`)
      if (object(schema.items)) current.forEach((entry, index) => visit(schema.items as SchemaNode, entry, `${path}[${index}]`, depth + 1))
    }
    if (object(current)) {
      const properties = object(schema.properties) ? schema.properties : {}
      if (Array.isArray(schema.required)) {
        for (const key of schema.required) {
          if (typeof key === 'string' && !Object.prototype.hasOwnProperty.call(current, key)) add(`${propertyPath(path, key)}: wajib diisi`)
        }
      }
      for (const [key, entry] of Object.entries(current)) {
        const child = properties[key]
        if (object(child)) visit(child as SchemaNode, entry, propertyPath(path, key), depth + 1)
        else if (schema.additionalProperties === false) add(`${propertyPath(path, key)}: field tidak dikenal`)
      }
    }
  }

  visit(parameters as SchemaNode, value, '$', 0)
  if (omitted) issues.push(`… ${omitted} masalah lain tidak ditampilkan`)
  return issues
}

export function toolArgumentFailure(name: string, issues: readonly string[]): string {
  return `${TOOL_ARGUMENT_GUARD_MARK}\nPanggilan ${name} ditolak sebelum preview, approval, dan eksekusi karena argumennya tidak sesuai schema:\n${issues.map((issue) => `- ${issue}`).join('\n')}\nPerbaiki argumennya berdasarkan schema tool; jangan ulangi payload yang sama.`
}

/** Instruksi trusted sementara karena hasil tool akan dibungkus sebagai data tak tepercaya. */
export function toolArgumentSystemPrompt(name: string, issues: readonly string[]): string {
  return `${TOOL_ARGUMENT_GUARD_MARK}\nThe local runtime rejected ${JSON.stringify(name)} before preview, approval, and execution. Fix the tool arguments according to its schema. Problems:\n${issues.map((issue) => `- ${issue}`).join('\n')}\nDo not repeat the same invalid payload and do not claim the tool ran.`
}
