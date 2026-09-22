import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Tool } from '../domain/tool.ts'
import { isSensitivePath, sensitiveRefusal } from './secrets.ts'

export const MAX_SKILLS = 100
export const MAX_SKILL_BYTES = 64 * 1024
export const MAX_SKILL_RESOURCE_BYTES = 60_000

export interface SkillDefinition {
  name: string
  description: string
  source: 'global' | 'project'
  directory: string
  skillFile: string
  label: string
}

export interface SkillSources { workspace: string; home?: string }

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

function scalar(value: string): string {
  const trimmed = value.trim()
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1)
  return trimmed
}

/** Metadata YAML sederhana yang dibutuhkan katalog; isi skill tetap dimuat on-demand. */
export function parseSkillMetadata(content: string, fallbackName: string): { name: string; description: string } {
  content = content.replace(/\r\n?/g, '\n')
  let name = fallbackName
  let description = ''
  if (content.startsWith('---\n')) {
    const end = content.indexOf('\n---', 4)
    if (end !== -1) {
      for (const line of content.slice(4, end).split('\n')) {
        const match = /^(name|description):\s*(.*)$/.exec(line)
        if (match?.[1] === 'name') name = scalar(match[2])
        if (match?.[1] === 'description') description = scalar(match[2])
      }
    }
  }
  if (!description) {
    const body = content.replace(/^---\n[\s\S]*?\n---\s*/, '')
    description = body.split('\n').map((line) => line.replace(/^#+\s*/, '').trim()).find(Boolean) ?? 'Instruksi tambahan untuk agent.'
  }
  return { name: name.trim(), description: description.replace(/\s+/g, ' ').trim().slice(0, 300) }
}

function discover(root: string, source: SkillDefinition['source'], shownRoot: string): SkillDefinition[] {
  let realRoot: string
  try { realRoot = realpathSync(root) } catch { return [] }
  const skills: SkillDefinition[] = []
  let entries
  try { entries = readdirSync(realRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)) } catch { return [] }
  for (const entry of entries) {
    if (!entry.isDirectory() || skills.length >= MAX_SKILLS) continue
    const candidate = join(realRoot, entry.name, 'SKILL.md')
    let skillFile: string
    let info
    try {
      skillFile = realpathSync(candidate)
      info = statSync(skillFile)
    } catch { continue }
    if (!info.isFile() || !isInside(skillFile, realRoot) || isSensitivePath(skillFile)) continue
    let head: string
    try { head = readFileSync(skillFile).subarray(0, 16 * 1024).toString('utf8') } catch { continue }
    const metadata = parseSkillMetadata(head, entry.name)
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(metadata.name)) continue
    skills.push({
      ...metadata,
      source,
      directory: dirname(skillFile),
      skillFile,
      label: source === 'global' ? `~/.boo/skills/${entry.name}/SKILL.md` : `${shownRoot}/${entry.name}/SKILL.md`.replace(/^\.\//, ''),
    })
  }
  return skills
}

/** Skill dengan nama sama yang paling dekat ke workspace menimpa versi global/induk. */
export function loadSkills({ workspace, home }: SkillSources): SkillDefinition[] {
  const root = resolve(workspace)
  const byName = new Map<string, SkillDefinition>()
  if (home) for (const skill of discover(join(home, '.boo', 'skills'), 'global', '~/.boo/skills')) byName.set(skill.name, skill)
  const top = projectRoot(root)
  for (const directory of directoriesBetween(top, root)) {
    const label = relative(root, join(directory, '.boo', 'skills')).split(sep).join('/') || '.boo/skills'
    for (const skill of discover(join(directory, '.boo', 'skills'), 'project', label)) byName.set(skill.name, skill)
  }
  return [...byName.values()].slice(0, MAX_SKILLS).sort((a, b) => a.name.localeCompare(b.name))
}

export function skillsSignature(skills: readonly SkillDefinition[]): string {
  return JSON.stringify(skills.map((skill) => [skill.name, skill.description, skill.skillFile, statStamp(skill.skillFile)]))
}

function statStamp(path: string): string {
  try { const info = statSync(path); return `${info.mtimeMs}:${info.size}` } catch { return '0:0' }
}

function catalog(context: { workspace: string; home?: string }): SkillDefinition[] {
  return loadSkills({ workspace: context.workspace, home: context.home })
}

function findSkill(name: string, context: { workspace: string; home?: string }): SkillDefinition | null {
  return catalog(context).find((skill) => skill.name === name) ?? null
}

export const listSkillsTool: Tool<Record<string, never>> = {
  name: 'list_skills',
  description: 'List optional Boo skills available globally and in this project. Skill bodies are not loaded until read_skill is called.',
  risk: 'safe',
  schema: { type: 'function', function: { name: 'list_skills', description: 'List available skills and their short descriptions.', parameters: { type: 'object', properties: {} } } },
  preview: () => 'lihat skill yang tersedia',
  async run(_args, context) {
    const skills = catalog(context)
    return { content: skills.length ? skills.map((skill) => `${skill.name} [${skill.source}] — ${skill.description}`).join('\n') : 'Tidak ada skill Boo yang tersedia.' }
  },
}

export const readSkillTool: Tool<{ name: string }> = {
  name: 'read_skill',
  description: 'Load the complete SKILL.md for one available skill. Call this before following a skill whose description matches the task.',
  risk: 'safe',
  schema: {
    type: 'function',
    function: {
      name: 'read_skill', description: 'Read one available skill by its exact catalog name.',
      parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    },
  },
  preview: (args) => `muat skill ${args.name}`,
  async run(args, context) {
    const skill = findSkill(args.name, context)
    if (!skill) return { content: `Gagal: skill "${args.name}" tidak tersedia. Gunakan list_skills untuk melihat nama yang valid.`, isError: true }
    const buffer = await readFile(skill.skillFile)
    const truncated = buffer.length > MAX_SKILL_BYTES
    const content = buffer.subarray(0, MAX_SKILL_BYTES).toString('utf8').replace(/\uFFFD$/, '')
    return { content: `# Skill ${skill.name}\nSumber: ${skill.label}\n\n${content}${truncated ? '\n\n[Skill dipotong karena melebihi 64 KiB.]' : ''}` }
  },
}

interface ResourceArgs { name: string; path: string }

export const readSkillResourceTool: Tool<ResourceArgs> = {
  name: 'read_skill_resource',
  description: 'Read a text resource referenced by a loaded skill, constrained to that skill directory.',
  risk: 'safe',
  schema: {
    type: 'function',
    function: {
      name: 'read_skill_resource', description: 'Read one supporting text file inside an available skill directory.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string' }, path: { type: 'string', description: 'Path relative to the skill directory' } },
        required: ['name', 'path'],
      },
    },
  },
  preview: (args) => `baca resource ${args.name}/${args.path}`,
  async run(args, context) {
    const skill = findSkill(args.name, context)
    if (!skill) return { content: `Gagal: skill "${args.name}" tidak tersedia.`, isError: true }
    if (!args.path || isAbsolute(args.path) || isSensitivePath(args.path)) {
      return { content: isSensitivePath(args.path) ? sensitiveRefusal(args.path) : 'Gagal: path resource harus relatif.', isError: true }
    }
    const candidate = resolve(skill.directory, args.path)
    let real: string
    try { real = realpathSync(candidate) } catch { return { content: `Gagal: resource ${args.path} tidak ditemukan.`, isError: true } }
    if (!isInside(real, skill.directory) || isSensitivePath(real)) return { content: 'Gagal: resource berada di luar direktori skill atau bersifat rahasia.', isError: true }
    const info = statSync(real)
    if (!info.isFile()) return { content: 'Gagal: resource bukan file.', isError: true }
    const buffer = await readFile(real)
    if (buffer.subarray(0, 8_000).includes(0)) return { content: 'Gagal: resource biner tidak dapat dimuat sebagai teks.', isError: true }
    const truncated = buffer.length > MAX_SKILL_RESOURCE_BYTES
    const content = buffer.subarray(0, MAX_SKILL_RESOURCE_BYTES).toString('utf8').replace(/\uFFFD$/, '')
    return { content: `${content}${truncated ? '\n\n[Resource dipotong.]' : ''}` }
  },
}
