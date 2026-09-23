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
  /** Pesan yang ikut dipertahankan karena menjadi dependency bukti terpilih. */
  dependencyMessages: number
  /** Edge dependency yang benar-benar dipakai saat memilih context. */
  dependencyEdges: number
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
  dependencyMessages: number
  dependencyEdges: number
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
    dependencyMessages: trimmed.dependencyMessages,
    dependencyEdges: trimmed.dependencyEdges,
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

function searchableBlock(block: readonly Message[], preserveCase = false): string {
  const parts: string[] = []
  for (const message of block) {
    if (message.content) parts.push(message.content.slice(0, 20_000))
    if (message.reasoning_content) parts.push(message.reasoning_content.slice(0, 4_000))
    for (const call of message.tool_calls ?? []) parts.push(call.function.name, call.function.arguments.slice(0, 8_000))
  }
  const text = parts.join('\n')
  return preserveCase ? text : text.toLowerCase()
}

export type ContextDependencyKind = 'task' | 'causal' | 'anchor' | 'verification'

export interface ContextDependencyEdge {
  /** Blok yang memerlukan konteks lebih lama. */
  from: number
  /** Blok dependency yang lebih lama. */
  to: number
  kind: ContextDependencyKind
}

export interface ContextDependencyGraph {
  blocks: number
  edges: ContextDependencyEdge[]
}

const MAX_DEPENDENCY_ANCHORS = 32
const MAX_DEPENDENCIES_PER_BLOCK = 8
const MAX_CONTEXT_DEPENDENCY_EDGES = 512
const MAX_DEPENDENCY_CLOSURE_BLOCKS = 12
const MAX_DEPENDENCY_DEPTH = 3
const MUTATION_TOOLS = new Set(['apply_patch', 'write_file', 'edit_file', 'memory_add', 'memory_remove', 'git_commit'])
const VERIFICATION_TOOLS = new Set(['bash', 'diagnostics', 'lsp', 'test_impact', 'change_impact'])

/** Anchor kuat saja; kata biasa tidak boleh menghubungkan seluruh percakapan. */
function dependencyAnchors(block: readonly Message[]): string[] {
  const source = searchableBlock(block, true)
  const camelCaseSymbols = new Set(
    (source.match(/\b[A-Za-z_$][A-Za-z0-9_$]*[A-Z][A-Za-z0-9_$]*\b/g) ?? []).map((term) => term.toLowerCase()),
  )
  const anchors = contextRelevanceTerms(source).filter((term) => {
    if (term.includes('/') || term.includes('.') || term.includes('_') || term.includes('-')) return true
    if (camelCaseSymbols.has(term)) return true
    return term.length >= 8
  })
  return anchors.slice(0, MAX_DEPENDENCY_ANCHORS)
}

function blockTools(block: readonly Message[]): string[] {
  return block.flatMap((message) => (message.tool_calls ?? []).map((call) => call.function.name))
}

function buildBlockDependencyGraph(blocks: readonly Message[][]): ContextDependencyGraph {
  const edges: ContextDependencyEdge[] = []
  const keys = new Set<string>()
  const counts = new Map<number, number>()
  const lastByAnchor = new Map<string, number>()
  let lastUser = -1
  let lastMutation = -1
  const add = (from: number, to: number, kind: ContextDependencyKind) => {
    if (from <= to || to < 0 || edges.length >= MAX_CONTEXT_DEPENDENCY_EDGES || (counts.get(from) ?? 0) >= MAX_DEPENDENCIES_PER_BLOCK) return
    const key = `${from}:${to}:${kind}`
    if (keys.has(key)) return
    keys.add(key)
    counts.set(from, (counts.get(from) ?? 0) + 1)
    edges.push({ from, to, kind })
  }

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]
    const isUser = block.some((message) => message.role === 'user')
    const tools = blockTools(block)
    if (!isUser && lastUser >= 0) add(index, lastUser, 'task')
    if (!isUser && index > 0 && (tools.length || blockTools(blocks[index - 1]).length)) add(index, index - 1, 'causal')
    if (tools.some((tool) => VERIFICATION_TOOLS.has(tool)) && lastMutation >= 0) add(index, lastMutation, 'verification')
    for (const anchor of dependencyAnchors(block)) {
      const previous = lastByAnchor.get(anchor)
      if (previous !== undefined) add(index, previous, 'anchor')
      lastByAnchor.set(anchor, index)
    }
    if (tools.some((tool) => MUTATION_TOOLS.has(tool))) lastMutation = index
    if (isUser) lastUser = index
  }
  return { blocks: blocks.length, edges }
}

/** Graph ephemeral untuk inspeksi/test; index mengacu pada blok non-system. */
export function buildContextDependencyGraph(messages: readonly Message[]): ContextDependencyGraph {
  let systemCount = 0
  while (messages[systemCount]?.role === 'system') systemCount += 1
  return buildBlockDependencyGraph(toBlocks([...messages.slice(systemCount)]))
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
  if (latest < 0) return { messages: system, estimatedTokens: systemTokens, droppedMessages: 0, prioritizedMessages: 0, dependencyMessages: 0, dependencyEdges: 0 }

  // Bila blok terbaru sendiri tidak muat, struktur lebih penting daripada ranking.
  if (costs[latest] > budget) {
    const shrunk = shrinkBlock(blocks[latest], budget)
    return {
      messages: [...system, ...shrunk],
      estimatedTokens: systemTokens + blockTokens(shrunk),
      droppedMessages: blocks.flat().length - shrunk.length,
      prioritizedMessages: 0,
      dependencyMessages: 0,
      dependencyEdges: 0,
    }
  }

  const graph = buildBlockDependencyGraph(blocks)
  const dependencies = new Map<number, ContextDependencyEdge[]>()
  for (const edge of graph.edges) dependencies.set(edge.from, [...(dependencies.get(edge.from) ?? []), edge])
  const selected = new Set<number>()
  const dependencyOnly = new Set<number>()
  const usedEdges = new Set<string>()
  let used = 0
  const closure = (root: number): { indices: number[]; edges: ContextDependencyEdge[] } => {
    const indices = new Set<number>([root])
    const includedEdges: ContextDependencyEdge[] = []
    const queue = [{ index: root, depth: 0 }]
    while (queue.length && indices.size < MAX_DEPENDENCY_CLOSURE_BLOCKS) {
      const current = queue.shift()!
      if (current.depth >= MAX_DEPENDENCY_DEPTH) continue
      for (const edge of dependencies.get(current.index) ?? []) {
        includedEdges.push(edge)
        if (indices.has(edge.to)) continue
        indices.add(edge.to)
        queue.push({ index: edge.to, depth: current.depth + 1 })
        if (indices.size >= MAX_DEPENDENCY_CLOSURE_BLOCKS) break
      }
    }
    return { indices: [...indices], edges: includedEdges }
  }
  const select = (index: number): boolean => {
    dependencyOnly.delete(index)
    if (selected.has(index)) return true
    const group = closure(index)
    const additions = group.indices.filter((entry) => !selected.has(entry))
    const cost = additions.reduce((total, entry) => total + costs[entry], 0)
    if (used + cost <= budget) {
      for (const entry of additions) {
        selected.add(entry)
        if (entry !== index) dependencyOnly.add(entry)
        used += costs[entry]
      }
      for (const edge of group.edges) {
        if (selected.has(edge.from) && selected.has(edge.to)) usedEdges.add(`${edge.from}:${edge.to}:${edge.kind}`)
      }
      return true
    }
    if (used + costs[index] > budget) return false
    selected.add(index)
    used += costs[index]
    return true
  }

  select(latest)
  const latestUser = blocks.findLastIndex((block) => block.some((message) => message.role === 'user'))
  const preferred = [latestUser, latest - 1, latest - 2].filter((index, position, all) => index >= 0 && all.indexOf(index) === position)
  for (const index of preferred) {
    select(index)
  }

  const ranked = blocks.map((block, index) => ({ index, score: relevanceScore(block, terms, index, blocks.length) }))
    .filter(({ index }) => !selected.has(index))
    .sort((left, right) => right.score - left.score || right.index - left.index)
  for (const { index } of ranked) {
    select(index)
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
    dependencyMessages: [...dependencyOnly].reduce((sum, index) => sum + blocks[index].length, 0),
    dependencyEdges: usedEdges.size,
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
  if (!messages.length) return { messages: [], estimatedTokens: 0, droppedMessages: 0, prioritizedMessages: 0, dependencyMessages: 0, dependencyEdges: 0 }

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
    return { messages: [...messages], estimatedTokens: totalTokens, droppedMessages: 0, prioritizedMessages: 0, dependencyMessages: 0, dependencyEdges: 0 }
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
      dependencyMessages: 0,
      dependencyEdges: 0,
    }
  }

  const kept = blocks.slice(cut).flat()
  return {
    messages: [...system, ...kept],
    estimatedTokens: systemTokens + used,
    droppedMessages: rest.length - kept.length,
    prioritizedMessages: 0,
    dependencyMessages: 0,
    dependencyEdges: 0,
  }
}
