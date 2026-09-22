/** Redaksi defensif pada batas terakhir sebelum data dikirim ke provider model. */

import type { Message } from '../domain/message.ts'

export const OUTBOUND_REDACTION_MARK = '[RAHASIA DISEMBUNYIKAN OLEH BOO]'

export interface OutboundRedactionOptions {
  /** Nilai rahasia yang sudah diketahui, misalnya API key provider aktif. */
  secrets?: readonly string[]
  /** Environment proses; hanya nama variabel yang tampak sensitif yang dipakai. */
  environment?: NodeJS.ProcessEnv
}

export interface RedactedText {
  text: string
  redactions: number
}

export interface RedactedMessages {
  messages: Message[]
  redactions: number
}

const SENSITIVE_ENV_NAME = /(?:^|_)(?:API_KEY|ACCESS_KEY|SECRET(?:_ACCESS_KEY)?|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|CLIENT_SECRET|CREDENTIALS?|KEY)(?:$|_)/i
const PROPERTY_NAME = String.raw`(?:api[_-]?key|access[_-]?key|access[_-]?token|auth[_-]?token|authorization|client[_-]?secret|credential|password|passwd|private[_-]?key|secret|token)`

function replacePattern(value: string, pattern: RegExp, replacement: string | ((...args: string[]) => string), count: { value: number }): string {
  return value.replace(pattern, (...args: string[]) => {
    count.value += 1
    return typeof replacement === 'string' ? replacement : replacement(...args)
  })
}

function variantsOf(secret: string): string[] {
  const value = secret.trim()
  if (value.length < 4) return []
  const variants = [value]
  if (value.length >= 8) {
    const encoded = encodeURIComponent(value)
    const base64 = Buffer.from(value).toString('base64')
    if (encoded !== value) variants.push(encoded)
    if (base64.length >= 12) variants.push(base64)
  }
  return variants
}

/** Nilai environment yang layak dianggap credential; nama dan nilainya tidak dikembalikan ke UI. */
export function knownOutboundSecrets(options: OutboundRedactionOptions = {}): string[] {
  const found = new Set<string>()
  for (const secret of options.secrets ?? []) for (const variant of variantsOf(secret)) found.add(variant)
  for (const [name, value] of Object.entries(options.environment ?? {})) {
    if (!value || value.length < 8 || !SENSITIVE_ENV_NAME.test(name)) continue
    for (const variant of variantsOf(value)) found.add(variant)
  }
  return [...found].sort((left, right) => right.length - left.length)
}

/**
 * Meredaksi nilai pasti lebih dulu, lalu format credential berkeyakinan tinggi.
 * Placeholder dan nama variabel dipertahankan agar model tahu data apa yang hilang.
 */
export function redactSensitiveText(input: string, options: OutboundRedactionOptions = {}): RedactedText {
  let text = input
  const count = { value: 0 }

  for (const secret of knownOutboundSecrets(options)) {
    if (!text.includes(secret)) continue
    const occurrences = text.split(secret).length - 1
    text = text.split(secret).join(OUTBOUND_REDACTION_MARK)
    count.value += occurrences
  }

  text = replacePattern(text, /-----BEGIN ((?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY)-----[\s\S]*?-----END \1-----/g, OUTBOUND_REDACTION_MARK, count)
  text = replacePattern(text, /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, OUTBOUND_REDACTION_MARK, count)
  text = replacePattern(text, /\bgh(?:p|o|u|s|r)_[A-Za-z0-9]{30,255}\b/g, OUTBOUND_REDACTION_MARK, count)
  text = replacePattern(text, /\bgithub_pat_[A-Za-z0-9_]{40,255}\b/g, OUTBOUND_REDACTION_MARK, count)
  text = replacePattern(text, /\bxox(?:b|p|a|r|s)-[A-Za-z0-9-]{10,255}\b/g, OUTBOUND_REDACTION_MARK, count)
  text = replacePattern(text, /\bsk_(?:live|test)_[A-Za-z0-9]{16,255}\b/g, OUTBOUND_REDACTION_MARK, count)
  text = replacePattern(text, /\bAIza[0-9A-Za-z_-]{30,255}\b/g, OUTBOUND_REDACTION_MARK, count)
  text = replacePattern(text, /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, OUTBOUND_REDACTION_MARK, count)

  text = replacePattern(text, /^(\s*(?:Authorization|Proxy-Authorization)\s*:\s*(?:Bearer|Basic)\s+)[^\r\n]+/gim, (...args) => `${args[1]}${OUTBOUND_REDACTION_MARK}`, count)
  text = replacePattern(text, /^(\s*(?:Cookie|Set-Cookie)\s*:\s*)[^\r\n]+/gim, (...args) => `${args[1]}${OUTBOUND_REDACTION_MARK}`, count)
  text = replacePattern(text, /\b(https?|wss?|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/([^/\s:@]+):([^@\s/]+)@/gi, (...args) => `${args[1]}://${OUTBOUND_REDACTION_MARK}@`, count)

  text = text.replace(/^(\s*(?:export\s+)?)([A-Z][A-Z0-9_]{1,100})(\s*=\s*)([^\r\n]*)$/gm, (match, prefix: string, name: string, separator: string, value: string) => {
    if (!SENSITIVE_ENV_NAME.test(name) || !value.trim()) return match
    count.value += 1
    return `${prefix}${name}${separator}${OUTBOUND_REDACTION_MARK}`
  })

  const quotedProperty = new RegExp(`(["']${PROPERTY_NAME}["']\\s*:\\s*)(["'])([^"'\\r\\n]*)\\2`, 'gi')
  text = replacePattern(text, quotedProperty, (...args) => `${args[1]}${args[2]}${OUTBOUND_REDACTION_MARK}${args[2]}`, count)
  const commandArgument = new RegExp(`(\\s--${PROPERTY_NAME}(?:=|\\s+))([^\\s]+)`, 'gi')
  text = replacePattern(text, commandArgument, (...args) => `${args[1]}${OUTBOUND_REDACTION_MARK}`, count)

  return { text, redactions: count.value }
}

/** Menyalin pesan; riwayat lokal tidak dimutasi dan tetap dapat di-resume apa adanya. */
export function redactOutboundMessages(input: readonly Message[], options: OutboundRedactionOptions = {}): RedactedMessages {
  let redactions = 0
  const redact = (value: string | null | undefined): string | null | undefined => {
    if (typeof value !== 'string') return value
    const result = redactSensitiveText(value, options)
    redactions += result.redactions
    return result.text
  }
  const messages = input.map((message): Message => ({
    ...message,
    content: redact(message.content),
    reasoning_content: redact(message.reasoning_content) ?? undefined,
    tool_calls: message.tool_calls?.map((call) => ({
      ...call,
      function: { ...call.function, arguments: redact(call.function.arguments) ?? '{}' },
    })),
    images: message.images?.map((image) => ({ ...image })),
  }))
  return { messages, redactions }
}
