/**
 * Pemangkasan konteks percakapan agent.
 *
 * Riwayat agent tumbuh jauh lebih cepat daripada chat biasa: satu `read_file`
 * menyuntikkan isi file penuh ke dalam percakapan. Tanpa pemangkasan, sesi
 * panjang akan melewati batas konteks model dan gagal.
 *
 * Aturan yang tidak boleh dilanggar saat memangkas:
 * - Pesan system selalu ikut; ia memuat identitas dan cara kerja Boo.
 * - Pesan `tool` tidak boleh menjadi pesan pertama. API menolak hasil tool yang
 *   kehilangan pesan assistant pemanggilnya, jadi titik potong digeser maju
 *   sampai mendarat di pesan non-tool.
 * - Pesan terbaru selalu diprioritaskan. Saat fokus task tersedia, blok lama yang
 *   menyebut path/simbol/error relevan dapat dipertahankan sebelum blok netral.
 */

import type { Message, ToolSchema } from '../domain/message.ts'

/** Perkiraan kasar: satu token kira-kira empat karakter. */
const CHARS_PER_TOKEN = 4
/** Biaya tetap per pesan untuk penanda peran dan pembatas. */
const MESSAGE_OVERHEAD_TOKENS = 8
/** Perkiraan pembungkus JSON/function calling per definisi tool. */
const TOOL_SCHEMA_OVERHEAD_TOKENS = 12
/** Gambar dihitung konservatif karena biaya persis bergantung provider/detail. */
const IMAGE_TOKENS = 1_200

export const DEFAULT_MAX_CONTEXT_TOKENS = 100_000

export interface TrimResult {
  messages: Message[]
  estimatedTokens: number
  droppedMessages: number
  /** Pesan lama relevan yang diselamatkan di luar ekor kronologis utuh. */
  prioritizedMessages: number
}

export interface TrimOptions {
  /** Tujuan task aktif; hanya dipakai untuk ranking lokal dan tidak disimpan. */
  focus?: string
}

export type ContextPressure = 'healthy' | 'attention' | 'critical'

export interface ContextBreakdown {
  system: number
  user: number
  assistant: number
  toolResults: number
  toolCalls: number
  images: number
  toolSchemas: number
}

/** Potret konteks yang benar-benar tersedia bagi model pada putaran berikutnya. */
export interface ContextReport {
  limitTokens: number
  /** Seluruh pesan setelah compaction aktif, sebelum jaring pengaman trimming. */
  currentTokens: number
  /** Pesan yang akan dikirim setelah trimming, ditambah skema tool. */
  sentTokens: number
  headroomTokens: number
  usagePercent: number
  pressure: ContextPressure
  messages: number
  sentMessages: number
  droppedMessages: number
  prioritizedMessages: number
  historyMessages: number
  summarizedMessages: number
  compactionActive: boolean
  breakdown: ContextBreakdown
}

export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

export function estimateMessageTokens(message: Message): number {
  const toolCallText = (message.tool_calls ?? [])
    .map((call) => call.function.name + call.function.arguments)
    .join('')
  return MESSAGE_OVERHEAD_TOKENS
    + estimateTextTokens(message.content ?? '')
    + estimateTextTokens(message.reasoning_content ?? '')
    + estimateTextTokens(toolCallText)
    // Perkiraan konservatif untuk image tokens; ukuran pasti bergantung provider/detail.
    + (message.images?.length ?? 0) * IMAGE_TOKENS
}

/** Skema function calling juga masuk request provider dan harus memakai anggaran. */
export function estimateToolSchemaTokens(schemas: readonly ToolSchema[]): number {
  return schemas.reduce((total, schema) => total + TOOL_SCHEMA_OVERHEAD_TOKENS + estimateTextTokens(JSON.stringify(schema)), 0)
}

/** Sisa anggaran khusus pesan setelah biaya skema tool disisihkan. */
export function messageContextBudget(maxTokens: number, schemas: readonly ToolSchema[]): number {
  return Math.max(0, maxTokens - estimateToolSchemaTokens(schemas))
}

function messageBreakdown(messages: readonly Message[]): Omit<ContextBreakdown, 'toolSchemas'> {
  const result = { system: 0, user: 0, assistant: 0, toolResults: 0, toolCalls: 0, images: 0 }
  for (const message of messages) {
    const content = MESSAGE_OVERHEAD_TOKENS
      + estimateTextTokens(message.content ?? '')
      + estimateTextTokens(message.reasoning_content ?? '')
    if (message.role === 'system') result.system += content
    else if (message.role === 'user') result.user += content
    else if (message.role === 'assistant') result.assistant += content
    else result.toolResults += content
    result.toolCalls += estimateTextTokens((message.tool_calls ?? []).map((call) => call.function.name + call.function.arguments).join(''))
    result.images += (message.images?.length ?? 0) * IMAGE_TOKENS
  }
  return result
}

/**
 * Menginspeksi konteks dengan jalur hitung yang sama seperti runtime. Fungsi ini
 * tidak mengubah riwayat dan tidak pernah mengirim isi prompt ke tempat lain.
 */
export function inspectContext(
  messages: readonly Message[],
  schemas: readonly ToolSchema[],
  maxTokens = DEFAULT_MAX_CONTEXT_TOKENS,
  metadata: { historyMessages?: number; summarizedMessages?: number } = {},
): ContextReport {
  const limitTokens = Number.isFinite(maxTokens) && maxTokens > 0 ? Math.floor(maxTokens) : DEFAULT_MAX_CONTEXT_TOKENS
  const toolSchemas = estimateToolSchemaTokens(schemas)
  const currentMessageTokens = messages.reduce((total, message) => total + estimateMessageTokens(message), 0)
  const focus = [...messages].reverse().find((message) => message.role === 'user' && message.content?.trim())?.content ?? ''
  const trimmed = trimToBudget([...messages], Math.max(0, limitTokens - toolSchemas), { focus })
  const currentTokens = currentMessageTokens + toolSchemas
  const sentTokens = trimmed.estimatedTokens + toolSchemas
  const usagePercent = Math.max(0, Math.round(sentTokens / limitTokens * 100))
  const pressure: ContextPressure = trimmed.droppedMessages > 0 || usagePercent >= 90
    ? 'critical'
    : usagePercent >= 75 ? 'attention' : 'healthy'
  return {
    limitTokens,
    currentTokens,
    sentTokens,
    headroomTokens: Math.max(0, limitTokens - sentTokens),
    usagePercent,
    pressure,
    messages: messages.length,
    sentMessages: trimmed.messages.length,
    droppedMessages: trimmed.droppedMessages,
    prioritizedMessages: trimmed.prioritizedMessages,
    historyMessages: metadata.historyMessages ?? Math.max(0, messages.length - 1),
    summarizedMessages: metadata.summarizedMessages ?? 0,
    compactionActive: (metadata.summarizedMessages ?? 0) > 0,
    breakdown: { ...messageBreakdown(messages), toolSchemas },
  }
}

/**
 * Memotong teks yang terlalu panjang, menyisakan bagian awal dan akhir karena
 * keduanya paling sering memuat konteks yang berguna.
 */
function truncateContent(content: string, tokenBudget: number): string {
  const maxCharacters = Math.max(0, tokenBudget * CHARS_PER_TOKEN)
  if (content.length <= maxCharacters) return content

  const marker = '\n\n[… dipotong agar muat dalam konteks …]\n\n'
  if (maxCharacters <= marker.length + 2) return content.slice(0, maxCharacters)
  const available = maxCharacters - marker.length
  const head = Math.ceil(available * 0.7)
  return `${content.slice(0, head)}${marker}${content.slice(-(available - head))}`
}

/**
 * Mengelompokkan pesan menjadi blok yang aman dipotong di antaranya: pesan
 * assistant yang memanggil tool digabung dengan seluruh hasil toolnya.
 */
function toBlocks(messages: Message[]): Message[][] {
  const blocks: Message[][] = []
  for (const message of messages) {
    const previous = blocks.at(-1)
    const continuesBlock = message.role === 'tool'
      && previous
      && previous[0].role === 'assistant'
      && Boolean(previous[0].tool_calls?.length)
    if (continuesBlock) previous.push(message)
    else blocks.push([message])
  }
  return blocks
}

function blockTokens(block: Message[]): number {
  return block.reduce((total, message) => total + estimateMessageTokens(message), 0)
}

const RELEVANCE_STOP_WORDS = new Set([
  'yang', 'dan', 'atau', 'untuk', 'dengan', 'dari', 'pada', 'dalam', 'ini', 'itu', 'agar', 'coba', 'tolong', 'lanjut', 'lanjutkan',
  'the', 'and', 'for', 'with', 'from', 'into', 'this', 'that', 'then', 'please', 'continue', 'implement', 'implementation',
  'buat', 'bisa', 'fitur', 'agent', 'boo', 'code', 'file', 'task', 'tool', 'hasil', 'error',
])
const MAX_RELEVANCE_TERMS = 80

/** Token fokus lokal. Path lengkap dan komponennya dipertahankan agar ranking stabil. */
export function contextRelevanceTerms(focus: string): string[] {
  const terms = new Set<string>()
  for (const raw of focus.toLowerCase().match(/[a-z0-9_@./-]{3,}/g) ?? []) {
    const clean = raw.replace(/^[@./]+|[.,:;!?]+$/g, '')
    if (!clean || RELEVANCE_STOP_WORDS.has(clean)) continue
    terms.add(clean)
    for (const part of clean.split(/[/_.-]+/)) {
      if (part.length >= 3 && !RELEVANCE_STOP_WORDS.has(part)) terms.add(part)
    }
    if (terms.size >= MAX_RELEVANCE_TERMS) break
  }
  return [...terms]
}

function searchableBlock(block: readonly Message[]): string {
  const parts: string[] = []
  for (const message of block) {
    if (message.content) parts.push(message.content.slice(0, 20_000))
    if (message.reasoning_content) parts.push(message.reasoning_content.slice(0, 4_000))
    for (const call of message.tool_calls ?? []) parts.push(call.function.name, call.function.arguments.slice(0, 8_000))
  }
  return parts.join('\n').toLowerCase()
}

function relevanceScore(block: readonly Message[], terms: readonly string[], index: number, total: number): number {
  const text = searchableBlock(block)
  let matches = 0
  for (const term of terms) {
    if (!text.includes(term)) continue
    matches += term.includes('/') || term.includes('.') ? 8 : Math.min(5, Math.max(2, Math.floor(term.length / 3)))
  }
  const user = block.some((message) => message.role === 'user') ? 3 : 0
  // Recency hanya pemecah seri; kecocokan task tetap faktor utama.
  return matches * 1_000 + user * 100 + index / Math.max(1, total)
}

/**
 * Memilih blok yang paling berguna tanpa mengubah urutan kronologis. Blok terbaru
 * selalu masuk; user request terakhir dan dua blok terbaru berikutnya diprioritaskan.
 */
function trimRelevant(system: Message[], blocks: Message[][], maxTokens: number, terms: string[]): TrimResult {
  const systemTokens = system.reduce((total, message) => total + estimateMessageTokens(message), 0)
  const budget = Math.max(0, maxTokens - systemTokens)
  const costs = blocks.map(blockTokens)
  const latest = blocks.length - 1
  if (latest < 0) return { messages: system, estimatedTokens: systemTokens, droppedMessages: 0, prioritizedMessages: 0 }

  // Bila blok terbaru sendiri tidak muat, struktur lebih penting daripada ranking.
  if (costs[latest] > budget) {
    const shrunk = shrinkBlock(blocks[latest], budget)
    return {
      messages: [...system, ...shrunk],
      estimatedTokens: systemTokens + blockTokens(shrunk),
      droppedMessages: blocks.flat().length - shrunk.length,
      prioritizedMessages: 0,
    }
  }

  const selected = new Set<number>([latest])
  let used = costs[latest]
  const latestUser = blocks.findLastIndex((block) => block.some((message) => message.role === 'user'))
  const preferred = [latestUser, latest - 1, latest - 2].filter((index, position, all) => index >= 0 && all.indexOf(index) === position)
  for (const index of preferred) {
    if (selected.has(index) || used + costs[index] > budget) continue
    selected.add(index)
    used += costs[index]
  }

  const ranked = blocks.map((block, index) => ({ index, score: relevanceScore(block, terms, index, blocks.length) }))
    .filter(({ index }) => !selected.has(index))
    .sort((left, right) => right.score - left.score || right.index - left.index)
  for (const { index } of ranked) {
    if (used + costs[index] > budget) continue
    selected.add(index)
    used += costs[index]
  }

  const ordered = [...selected].sort((left, right) => left - right)
  let contiguousStart = latest
  while (contiguousStart > 0 && selected.has(contiguousStart - 1)) contiguousStart -= 1
  const prioritizedMessages = ordered.filter((index) => index < contiguousStart).reduce((sum, index) => sum + blocks[index].length, 0)
  const kept = ordered.flatMap((index) => blocks[index])
  return {
    messages: [...system, ...kept],
    estimatedTokens: systemTokens + used,
    droppedMessages: blocks.flat().length - kept.length,
    prioritizedMessages,
  }
}

/**
 * Menyusutkan satu blok agar muat dalam anggaran dengan memotong isi pesannya.
 * Panggilan tool pada pesan assistant tidak disentuh karena strukturnya wajib
 * tetap utuh; yang dipotong adalah isi teks, terutama hasil tool yang besar.
 */
function shrinkBlock(block: Message[], tokenBudget: number): Message[] {
  const fixed = block.reduce((total, message) => {
    const toolCallText = (message.tool_calls ?? [])
      .map((call) => call.function.name + call.function.arguments)
      .join('')
    return total + MESSAGE_OVERHEAD_TOKENS + estimateTextTokens(toolCallText)
  }, 0)

  const forContent = Math.max(0, tokenBudget - fixed)
  const fields = block.reduce((total, message) => total + (message.content ? 1 : 0) + (message.reasoning_content ? 1 : 0), 0)
  const share = Math.max(0, Math.floor(forContent / Math.max(1, fields)))
  return block.map((message) => ({
    ...message,
    ...(message.content ? { content: truncateContent(message.content, share) } : {}),
    ...(message.reasoning_content ? { reasoning_content: truncateContent(message.reasoning_content, share) } : {}),
  }))
}

/**
 * Menyusun pesan yang dikirim ke model agar muat dalam anggaran token.
 * Riwayat aslinya tidak diubah — pemangkasan hanya berlaku untuk satu permintaan.
 */
export function trimToBudget(
  messages: Message[],
  maxTokens = DEFAULT_MAX_CONTEXT_TOKENS,
  options: TrimOptions = {},
): TrimResult {
  if (!messages.length) return { messages: [], estimatedTokens: 0, droppedMessages: 0, prioritizedMessages: 0 }

  let systemCount = 0
  while (messages[systemCount]?.role === 'system') systemCount += 1
  const system = messages.slice(0, systemCount)
  const rest = messages.slice(systemCount)

  const systemTokens = system.reduce((total, message) => total + estimateMessageTokens(message), 0)
  const budget = Math.max(0, maxTokens - systemTokens)
  const blocks = toBlocks(rest)
  const terms = contextRelevanceTerms(options.focus ?? '')
  const totalTokens = blocks.reduce((total, block) => total + blockTokens(block), systemTokens)
  if (totalTokens <= maxTokens) {
    return { messages: [...messages], estimatedTokens: totalTokens, droppedMessages: 0, prioritizedMessages: 0 }
  }
  if (terms.length) return trimRelevant(system, blocks, maxTokens, terms)

  let used = 0
  let cut = blocks.length
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const tokens = blockTokens(blocks[index])
    if (used + tokens > budget) break
    used += tokens
    cut = index
  }

  // Blok terakhir pun tidak muat: pertahankan blok itu dan potong isinya, supaya
  // pasangan tool_use dan tool_result tidak pernah terpisah.
  if (cut === blocks.length && blocks.length) {
    const shrunk = shrinkBlock(blocks[blocks.length - 1], budget)
    const dropped = rest.length - shrunk.length
    return {
      messages: [...system, ...shrunk],
      estimatedTokens: systemTokens + blockTokens(shrunk),
      droppedMessages: dropped,
      prioritizedMessages: 0,
    }
  }

  const kept = blocks.slice(cut).flat()
  return {
    messages: [...system, ...kept],
    estimatedTokens: systemTokens + used,
    droppedMessages: rest.length - kept.length,
    prioritizedMessages: 0,
  }
}
