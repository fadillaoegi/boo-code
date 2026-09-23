/** Custom slash commands berbasis Markdown, tanpa database. */

import { existsSync, readFileSync, realpathSync, readdirSync, statSync } from 'node:fs'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { isSensitivePath } from '../tools/secrets.ts'
import { referencedPromptTitle } from './references.ts'

export const MAX_PROMPT_COMMANDS = 100
export const MAX_PROMPT_COMMAND_BYTES = 64 * 1024
export const PROMPT_COMMAND_MARK = '[Boo custom command]'

const RESERVED = new Set([
  'apps', 'attach', 'attachments', 'capabilities', 'compact', 'commands', 'exit', 'help', 'implement', 'init', 'keluar',
  'hooks', 'model', 'open', 'plan', 'queue', 'resume', 'review', 'run', 'spec', 'stats', 'undo',
  'postmortem', 'status',
])

export interface PromptCommand {
  name: string
  description: string
  source: 'global' | 'project'
  file: string
  label: string
}

export interface PromptCommandSources { workspace: string; home?: string }
export interface ExpandedPromptCommand { display: string; prompt: string; command: PromptCommand }

function isInside(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)
}

function projectRoot(workspace: string): string {
  let directory = resolve(workspace)
  for (;;) {
    if (existsSync(join(directory, '.git'))) return directory
    const parent = dirname(directory)
    if (parent === directory) return resolve(workspace)
    directory = parent
  }
}

function directoriesBetween(root: string, workspace: string): string[] {
  const found = [root]
  let current = root
  const rest = relative(root, workspace)
  if (!rest) return found
  for (const segment of rest.split(sep)) {
    current = join(current, segment)
    found.push(current)
  }
  return found
}

function withoutFrontmatter(content: string): string {
  const normalized = content.replace(/\r\n?/g, '\n')
  if (!normalized.startsWith('---\n')) return normalized.trim()
  const end = normalized.indexOf('\n---', 4)
  return end === -1 ? normalized.trim() : normalized.slice(end + 4).trim()
}

export function parsePromptCommandDescription(content: string): string {
  const normalized = content.replace(/\r\n?/g, '\n')
  if (normalized.startsWith('---\n')) {
    const end = normalized.indexOf('\n---', 4)
    if (end !== -1) {
      const line = normalized.slice(4, end).split('\n').find((candidate) => /^description:\s*/.test(candidate))
      if (line) return line.replace(/^description:\s*/, '').trim().replace(/^(['"])(.*)\1$/, '$2').replace(/\s+/g, ' ').slice(0, 200)
    }
  }
  return withoutFrontmatter(normalized).split('\n').map((line) => line.replace(/^#+\s*/, '').trim()).find(Boolean)?.slice(0, 200) ?? 'Prompt proyek yang dapat dipakai ulang.'
}

function discover(root: string, source: PromptCommand['source'], shownRoot: string): PromptCommand[] {
  let realRoot: string
  try { realRoot = realpathSync(root) } catch { return [] }
  const found: PromptCommand[] = []
  const visit = (directory: string) => {
    if (found.length >= MAX_PROMPT_COMMANDS) return
    let entries
    try { entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)) } catch { return }
    for (const entry of entries) {
      if (found.length >= MAX_PROMPT_COMMANDS || entry.isSymbolicLink()) continue
      const candidate = join(directory, entry.name)
      if (entry.isDirectory()) {
        visit(candidate)
        continue
      }
      if (!entry.isFile() || extname(entry.name).toLowerCase() !== '.md') continue
      let file: string
      let info
      try {
        file = realpathSync(candidate)
        info = statSync(file)
      } catch { continue }
      if (!info.isFile() || info.size > MAX_PROMPT_COMMAND_BYTES || !isInside(file, realRoot) || isSensitivePath(file)) continue
      const stem = relative(realRoot, file).slice(0, -3).split(sep)
      if (!stem.every((part) => /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(part))) continue
      const name = stem.join(':').toLowerCase()
      if (RESERVED.has(name)) continue
      let content: string
      try { content = readFileSync(file, 'utf8') } catch { continue }
      if (!withoutFrontmatter(content)) continue
      found.push({
        name,
        description: parsePromptCommandDescription(content),
        source,
        file,
        label: `${shownRoot}/${relative(realRoot, file).split(sep).join('/')}`,
      })
    }
  }
  visit(realRoot)
  return found
}

/** Command proyek terdekat menimpa command induk/global dengan nama sama. */
export function loadPromptCommands({ workspace, home }: PromptCommandSources): PromptCommand[] {
  const root = resolve(workspace)
  const byName = new Map<string, PromptCommand>()
  if (home) for (const command of discover(join(home, '.boo', 'commands'), 'global', '~/.boo/commands')) byName.set(command.name, command)
  const top = projectRoot(root)
  for (const directory of directoriesBetween(top, root)) {
    const shown = relative(root, join(directory, '.boo', 'commands')).split(sep).join('/') || '.boo/commands'
    for (const command of discover(join(directory, '.boo', 'commands'), 'project', shown)) byName.set(command.name, command)
  }
  return [...byName.values()].slice(0, MAX_PROMPT_COMMANDS).sort((a, b) => a.name.localeCompare(b.name))
}

/** Mengenali command dan memperluas `$ARGUMENTS`; null berarti input biasa. */
export function expandPromptCommand(input: string, commands: readonly PromptCommand[]): ExpandedPromptCommand | null {
  const match = /^\/([a-z0-9][a-z0-9_:-]{0,127})(?:\s+([\s\S]*))?$/i.exec(input.trim())
  if (!match) return null
  const command = commands.find((candidate) => candidate.name === match[1].toLowerCase())
  if (!command) return null
  const args = (match[2] ?? '').trim()
  if (realpathSync(command.file) !== command.file || isSensitivePath(command.file)) throw new Error(`Command /${command.name} tidak lagi aman untuk dibaca.`)
  const info = statSync(command.file)
  if (info.size > MAX_PROMPT_COMMAND_BYTES) throw new Error(`Command /${command.name} melebihi 64 KiB.`)
  const body = withoutFrontmatter(readFileSync(command.file, 'utf8'))
  if (!body) throw new Error(`Command /${command.name} kosong.`)
  const expanded = body.includes('$ARGUMENTS')
    ? body.replaceAll('$ARGUMENTS', args)
    : `${body}${args ? `\n\nUser arguments:\n${args}` : ''}`
  const display = `/${command.name}${args ? ` ${args}` : ''}`
  return { command, display, prompt: `${PROMPT_COMMAND_MARK}\n${JSON.stringify(display)}\n\n${expanded}` }
}

/** Mengembalikan command asli untuk transcript sesi yang dilanjutkan. */
export function promptCommandTitle(content: string): string | null {
  const visible = referencedPromptTitle(content) ?? content
  if (!visible.startsWith(`${PROMPT_COMMAND_MARK}\n`)) return null
  const line = visible.slice(PROMPT_COMMAND_MARK.length + 1).split('\n', 1)[0]
  try {
    const parsed: unknown = JSON.parse(line)
    return typeof parsed === 'string' && parsed.startsWith('/') ? parsed : null
  } catch {
    return null
  }
}
