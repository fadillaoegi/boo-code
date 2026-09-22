/**
 * Fase pekerjaan agent dan ringkasannya, dipakai bersama CLI dan web.
 *
 * Yang ingin diketahui pengguna bukan setiap isi berkas yang dibaca, melainkan
 * Boo sedang apa dan sudah sejauh mana: "Exploring 3 files", "Applying app.ts".
 */

/** Tiga fase yang mencerminkan apa yang benar-benar dikerjakan agent. */
/** Kelompok pekerjaan yang dibekukan menjadi baris ringkasan. */
export type Phase = 'exploring' | 'applying'

export const PHASE_LABEL: Record<Phase, string> = {
  exploring: 'Exploring',
  applying: 'Applying',
}

/** Menghitung pekerjaan tiap fase agar ringkasannya bermakna, bukan sekadar "selesai". */
export class PhaseTally {
  private filesRead = 0
  private dirsListed = 0
  private searches = 0
  private delegations = 0
  private readonly changed: string[] = []
  private commands = 0
  private checks = 0
  private stopped = 0
  private failures = 0

  reset(): void {
    this.filesRead = 0
    this.dirsListed = 0
    this.searches = 0
    this.delegations = 0
    this.changed.length = 0
    this.commands = 0
    this.checks = 0
    this.stopped = 0
    this.failures = 0
  }

  record(tool: string, isError: boolean, target: string): void {
    if (isError) this.failures += 1
    switch (tool) {
      case 'read_file':
        this.filesRead += 1
        break
      case 'read_tool_output':
        this.searches += 1
        break
      case 'list_dir':
        this.dirsListed += 1
        break
      case 'glob':
      case 'grep':
      case 'tool_search':
      case 'code_search':
      case 'code_graph':
      case 'test_impact':
      case 'git_status':
      case 'git_changed_files':
      case 'git_diff':
      case 'git_log':
      case 'git_show':
      case 'git_blame':
      case 'repo_map':
      case 'web_search':
      case 'web_fetch':
      case 'browser_status':
      case 'browser_tabs':
      case 'browser_snapshot':
      case 'browser_diagnostics':
      case 'lsp':
      case 'list_skills':
      case 'read_skill':
      case 'read_skill_resource':
      case 'list_mcp_servers':
      case 'mcp_list_tools':
      case 'memory_list':
        this.searches += 1
        break
      case 'delegate':
      case 'delegate_write':
        this.delegations += 1
        break
      case 'bash':
      case 'bash_input':
        this.commands += 1
        break
      case 'git_commit':
        if (!isError && !this.changed.includes('Git commit')) this.changed.push('Git commit')
        break
      case 'bash_output':
      case 'diagnostics':
        this.checks += 1
        break
      case 'bash_kill':
        this.stopped += 1
        break
      case 'todo_write':
        break
      case 'memory_add':
      case 'memory_remove':
        if (!isError && !this.changed.includes('project memory')) this.changed.push('project memory')
        break
      default:
        if (!isError && target && !this.changed.includes(target)) this.changed.push(target)
    }
  }

  /** Ringkasan fase exploring, misalnya "3 files, 5 directories". */
  exploring(): string {
    const parts: string[] = []
    if (this.filesRead) parts.push(`${this.filesRead} file${this.filesRead > 1 ? 's' : ''}`)
    if (this.dirsListed) parts.push(`${this.dirsListed} director${this.dirsListed > 1 ? 'ies' : 'y'}`)
    if (this.searches) parts.push(`${this.searches} search${this.searches > 1 ? 'es' : ''}`)
    if (this.delegations) parts.push(`${this.delegations} delegation${this.delegations > 1 ? 's' : ''}`)
    return parts.join(', ') || 'scanning'
  }

  /** Ringkasan fase applying, misalnya "hitung.js, app.ts · 2 commands". */
  applying(): string {
    const parts: string[] = []
    if (this.changed.length) parts.push(this.changed.join(', '))
    if (this.commands) parts.push(`${this.commands} command${this.commands > 1 ? 's' : ''}`)
    if (this.checks) parts.push(`${this.checks} output check${this.checks > 1 ? 's' : ''}`)
    if (this.stopped) parts.push(`${this.stopped} stopped`)
    if (this.failures) parts.push(`${this.failures} failed`)
    return parts.join(' · ') || 'applying'
  }
}

/** Menentukan fase dari nama tool. */
const EXPLORING_TOOLS = new Set(['read_file', 'read_tool_output', 'list_dir', 'glob', 'grep', 'tool_search', 'code_search', 'code_graph', 'test_impact', 'repo_map', 'web_search', 'web_fetch', 'browser_status', 'browser_tabs', 'browser_snapshot', 'browser_diagnostics', 'git_status', 'git_changed_files', 'git_diff', 'git_log', 'git_show', 'git_blame', 'lsp', 'delegate', 'memory_list', 'list_skills', 'read_skill', 'read_skill_resource', 'list_mcp_servers', 'mcp_list_tools'])

export function phaseOf(tool: string): Phase {
  return EXPLORING_TOOLS.has(tool) ? 'exploring' : 'applying'
}
