import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Agent } from '../src/agent/loop.ts'
import { composeSystemPrompt } from '../src/agent/instructions.ts'
import type { Message } from '../src/domain/message.ts'
import type { NineRouterProvider } from '../src/provider/nineRouter.ts'
import { createDefaultRegistry } from '../src/tools/index.ts'
import { listSkillsTool, loadSkills, parseSkillMetadata, readSkillResourceTool, readSkillTool } from '../src/tools/skills.ts'

function skill(root: string, name: string, description: string, body: string): void {
  const directory = join(root, name)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`)
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'boo-skills-repo-'))
  mkdirSync(join(root, '.git'))
  const workspace = join(root, 'packages', 'app')
  mkdirSync(workspace, { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'boo-skills-home-'))
  return { root, workspace, home }
}

test('metadata frontmatter dibaca tanpa memuat seluruh isi sebagai deskripsi', () => {
  assert.deepEqual(parseSkillMetadata('---\r\nname: deploy\r\ndescription: "Deploy dengan aman"\r\n---\r\nRAHASIA BODY', 'fallback'), {
    name: 'deploy', description: 'Deploy dengan aman',
  })
  assert.deepEqual(parseSkillMetadata('# Review kode\nIkuti checklist.', 'review'), {
    name: 'review', description: 'Review kode',
  })
})

test('skill proyek menimpa global dan katalog hanya membawa metadata', () => {
  const { root, workspace, home } = fixture()
  skill(join(home, '.boo', 'skills'), 'deploy', 'versi global', 'INSTRUKSI GLOBAL RAHASIA')
  skill(join(root, '.boo', 'skills'), 'deploy', 'versi proyek', 'INSTRUKSI PROYEK RAHASIA')
  skill(join(root, '.boo', 'skills'), 'review', 'review perubahan', 'Periksa diff.')

  const skills = loadSkills({ workspace, home })
  assert.deepEqual(skills.map((entry) => [entry.name, entry.description, entry.source]), [
    ['deploy', 'versi proyek', 'project'], ['review', 'review perubahan', 'project'],
  ])
  const prompt = composeSystemPrompt('DASAR', [], skills)
  assert.match(prompt, /deploy \[project\]: versi proyek/)
  assert.match(prompt, /call read_skill/)
  assert.doesNotMatch(prompt, /INSTRUKSI .* RAHASIA/)
})

test('symlink SKILL.md ke luar root tidak masuk katalog', () => {
  const { root, workspace } = fixture()
  const outside = mkdtempSync(join(tmpdir(), 'boo-skills-outside-'))
  writeFileSync(join(outside, 'SKILL.md'), 'jangan dibaca')
  const directory = join(root, '.boo', 'skills', 'evil')
  mkdirSync(directory, { recursive: true })
  symlinkSync(join(outside, 'SKILL.md'), join(directory, 'SKILL.md'))
  assert.deepEqual(loadSkills({ workspace }), [])
})

test('tool memuat skill dan resource, tetapi menolak traversal serta rahasia', async () => {
  const { root, workspace } = fixture()
  const skillsRoot = join(root, '.boo', 'skills')
  skill(skillsRoot, 'review', 'review perubahan', 'Baca references/checklist.md.')
  mkdirSync(join(skillsRoot, 'review', 'references'))
  writeFileSync(join(skillsRoot, 'review', 'references', 'checklist.md'), '1. Periksa test\n')
  writeFileSync(join(skillsRoot, 'review', '.env'), 'TOKEN=jangan-bocor\n')
  const context = { workspace }

  const listed = await listSkillsTool.run({}, context)
  assert.match(listed.content, /review \[project\] — review perubahan/)
  const loaded = await readSkillTool.run({ name: 'review' }, context)
  assert.match(loaded.content, /Baca references\/checklist\.md/)
  const resource = await readSkillResourceTool.run({ name: 'review', path: 'references/checklist.md' }, context)
  assert.match(resource.content, /Periksa test/)
  assert.equal((await readSkillResourceTool.run({ name: 'review', path: '../../SKILL.md' }, context)).isError, true)
  const secret = await readSkillResourceTool.run({ name: 'review', path: '.env' }, context)
  assert.equal(secret.isError, true)
  assert.doesNotMatch(secret.content, /TOKEN=/)
})

test('agent memperbarui katalog skill pada permintaan berikutnya', async () => {
  const { root, workspace } = fixture()
  const seen: Message[][] = []
  const provider = {
    model: 'palsu',
    stream(messages: Message[]) {
      seen.push(messages.map((message) => ({ ...message })))
      // eslint-disable-next-line require-yield
      return (async function* reply() {
        return { finishReason: 'stop', message: { role: 'assistant' as const, content: 'ok' } }
      })()
    },
  } as unknown as NineRouterProvider
  const agent = new Agent({
    provider, registry: createDefaultRegistry(), workspace, askPermission: async () => true,
    skills: () => loadSkills({ workspace }),
  })
  for await (const event of agent.send('satu')) void event
  assert.doesNotMatch(String(seen[0][0].content), /Available skills/)
  skill(join(root, '.boo', 'skills'), 'review', 'review hot reload', 'Isi skill.')
  for await (const event of agent.send('dua')) void event
  assert.match(String(seen[1][0].content), /review \[project\]: review hot reload/)
  assert.equal(agent.history.filter((message) => message.role === 'system').length, 1)
})
