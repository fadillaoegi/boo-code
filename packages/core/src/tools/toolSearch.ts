/** Katalog tool dinamis agar provider hanya menerima skema yang relevan. */

import type { Tool, ToolRegistry } from '../domain/tool.ts'

export const TOOL_SEARCH_MAX_RESULTS = 12
export const TOOL_SEARCH_DEFAULT_RESULTS = 8

export const DEFAULT_CORE_TOOL_NAMES = [
  'read_file',
  'read_tool_output',
  'list_dir',
  'glob',
  'grep',
  'code_search',
  'code_graph',
  'repo_map',
  'git_status',
  'write_file',
  'edit_file',
  'apply_patch',
  'bash',
  'todo_write',
  'ask_user',
] as const

interface ToolSearchArgs extends Record<string, unknown> {
  query: string
  max_results?: number
}

export interface DiscoverableRegistryOptions {
  /** Tool yang selalu terlihat tanpa pencarian. Nama yang tidak ada diabaikan. */
  alwaysAvailable?: readonly string[]
}

export interface DiscoverableToolRegistry extends ToolRegistry {
  search(query: string, maxResults?: number): Tool[]
}

const SEARCH_TERMS: Record<string, string> = {
  code_graph: 'ast syntax graph symbol definition references callers callees inheritance extends implements call hierarchy relasi pemanggil definisi simbol',
  test_impact: 'test testing affected impact dependency verification verify pemeriksaan pengujian terdampak',
  diagnostics: 'diagnostic diagnostics typecheck lint build compile error pemeriksaan diagnosis',
  lsp: 'language server definition references hover symbols type diagnostics definisi referensi simbol',
  git_changed_files: 'git change changed files branch revision perubahan berkas',
  git_diff: 'git diff patch changes working tree perubahan',
  git_log: 'git history log commits sejarah riwayat',
  git_show: 'git show commit patch history inspect lihat riwayat',
  git_blame: 'git blame author origin history line asal baris riwayat',
  git_commit: 'git commit create record changes buat simpan perubahan',
  web_search: 'web internet online current latest search research cari riset terbaru',
  web_fetch: 'web internet url page article fetch read website halaman baca',
  list_apps: 'desktop application app program installed registered device aplikasi perangkat',
  open_app: 'desktop application app launch open program aplikasi buka jalankan perangkat',
  whatsapp_status: 'whatsapp wa web chat message status login pesan',
  whatsapp_send_message: 'whatsapp wa web chat send message contact kirim pesan kontak',
  delegate: 'subagent sub-agent parallel investigate research delegate delegasi paralel investigasi',
  delegate_write: 'subagent sub-agent parallel implementation edit worktree delegate delegasi implementasi paralel',
  memory_list: 'memory notes facts remember project memori catatan ingat proyek',
  memory_add: 'memory save note fact remember memori simpan catatan fakta',
  memory_remove: 'memory delete remove note forget memori hapus catatan lupa',
  list_skills: 'skill workflow instructions capability kemampuan alur instruksi',
  read_skill: 'skill workflow instructions resource kemampuan alur instruksi',
  read_skill_resource: 'skill resource template reference workflow referensi templat',
  list_mcp_servers: 'mcp server integration external connector integrasi konektor',
  mcp_list_tools: 'mcp server tools integration external connector integrasi konektor',
  mcp_call: 'mcp call server tool integration external connector panggil integrasi',
  bash_output: 'terminal shell command background process output logs status keluaran proses latar',
  bash_input: 'terminal shell command background process stdin input interactive masukan interaktif',
  bash_kill: 'terminal shell command background process stop kill hentikan proses latar',
}

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'atau', 'can', 'cari', 'dapat', 'dan', 'di', 'for', 'find', 'guna',
  'i', 'ingin', 'ke', 'mau', 'of', 'please', 'saya', 'the', 'to', 'tool', 'tools', 'untuk',
  'use', 'yang',
])

function words(value: string): string[] {
  return value.toLowerCase().replace(/[^a-z0-9_]+/g, ' ').split(/\s+/).filter((word) => word && !STOP_WORDS.has(word))
}

function cleanDescription(value: string): string {
  return Array.from(value, (character) => {
    const code = character.charCodeAt(0)
    return code < 32 || (code >= 127 && code <= 159) ? ' ' : character
  }).join('').replace(/\s+/g, ' ').trim().slice(0, 220)
}

function resultLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return TOOL_SEARCH_DEFAULT_RESULTS
  return Math.max(1, Math.min(TOOL_SEARCH_MAX_RESULTS, Math.floor(value)))
}

function toolScore(tool: Tool, query: string, queryWords: readonly string[]): number {
  const name = tool.name.toLowerCase()
  const description = tool.description.toLowerCase()
  const extra = SEARCH_TERMS[name] ?? ''
  const nameWords = new Set(words(name))
  const extraWords = new Set(words(extra))
  const descriptionWords = new Set(words(description))
  let score = name === query ? 1_000 : name.includes(query) ? 120 : 0
  for (const word of queryWords) {
    if (nameWords.has(word)) score += 45
    else if (name.includes(word)) score += 25
    if (extraWords.has(word)) score += 15
    if (descriptionWords.has(word)) score += 5
  }
  if (queryWords.length && queryWords.every((word) => name.includes(word) || extra.includes(word) || description.includes(word))) score += 20
  return score
}

/**
 * `list` dan `get` tetap melihat katalog penuh. Hanya `schemas` yang dipangkas,
 * sehingga policy, approval, dan sesi lama tidak bergantung pada hasil pencarian.
 */
export function createDiscoverableRegistry(tools: readonly Tool[], options: DiscoverableRegistryOptions = {}): DiscoverableToolRegistry {
  const catalog = tools.filter((tool) => tool.name !== 'tool_search')
  const byName = new Map(catalog.map((tool) => [tool.name, tool]))
  const initial = new Set((options.alwaysAvailable ?? DEFAULT_CORE_TOOL_NAMES).filter((name) => byName.has(name)))
  const active = new Set(initial)

  const search = (rawQuery: string, maxResults = TOOL_SEARCH_DEFAULT_RESULTS): Tool[] => {
    const query = rawQuery.trim().toLowerCase()
    if (!query || query.length > 200) return []
    const queryWords = words(query)
    if (!queryWords.length) return []
    const matches = catalog
      .map((tool) => ({ tool, score: toolScore(tool, query, queryWords) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
      .slice(0, resultLimit(maxResults))
      .map((item) => item.tool)
    for (const tool of matches) active.add(tool.name)
    return matches
  }

  const toolSearch: Tool<ToolSearchArgs> = {
    name: 'tool_search',
    description: 'Search the local tool catalog by capability and activate matching tools for the rest of the current task. Use a focused capability query when the tool you need is not currently available.',
    risk: 'safe',
    schema: {
      type: 'function',
      function: {
        name: 'tool_search',
        description: 'Search and activate specialized Boo tools. Examples: "browser interaction", "git history", "project diagnostics", "WhatsApp message", or "MCP integration".',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', minLength: 1, maxLength: 200, description: 'Focused capability or tool name to find' },
            max_results: { type: 'integer', minimum: 1, maximum: TOOL_SEARCH_MAX_RESULTS, description: `Maximum matches to activate (default ${TOOL_SEARCH_DEFAULT_RESULTS})` },
          },
          required: ['query'],
        },
      },
    },
    preview: (args) => `cari tool untuk ${JSON.stringify(args.query)}`,
    async run(args) {
      if (typeof args.query !== 'string' || !args.query.trim()) return { content: 'Gagal: query tool harus berupa teks yang tidak kosong.', isError: true }
      if (args.query.length > 200) return { content: 'Gagal: query tool melebihi 200 karakter.', isError: true }
      const matches = search(args.query, resultLimit(args.max_results))
      if (!matches.length) {
        return {
          content: 'Tidak ada tool yang cocok. Gunakan capability yang lebih spesifik, misalnya browser, web research, git history, diagnostics, memory, skills, MCP, desktop apps, background process, atau WhatsApp.',
          isError: true,
        }
      }
      const rows = matches.map((tool) => `- ${tool.name}: ${cleanDescription(tool.description)}`)
      return { content: `Diaktifkan untuk task ini (${matches.length}):\n${rows.join('\n')}\n\nSkema tersebut tersedia mulai putaran model berikutnya.` }
    },
  }

  return {
    list: () => [...catalog, toolSearch],
    get: (name) => name === toolSearch.name ? toolSearch : byName.get(name),
    schemas: () => [toolSearch.schema, ...catalog.filter((tool) => active.has(tool.name)).map((tool) => tool.schema)],
    beginTask: () => {
      active.clear()
      for (const name of initial) active.add(name)
    },
    activeNames: () => [toolSearch.name, ...catalog.filter((tool) => active.has(tool.name)).map((tool) => tool.name)],
    search,
  }
}
