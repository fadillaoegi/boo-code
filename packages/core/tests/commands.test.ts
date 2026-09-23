import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expandPromptCommand, loadPromptCommands, parsePromptCommandDescription, promptCommandTitle } from '../src/agent/commands.ts'
import { buildTranscript } from '../src/presentation/transcript.ts'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'boo-commands-repo-'))
  mkdirSync(join(root, '.git'))
  const workspace = join(root, 'packages', 'app')
  mkdirSync(workspace, { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'boo-commands-home-'))
  return { root, workspace, home }
}

function command(directory: string, name: string, body: string): void {
  const file = join(directory, ...name.split('/'))
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(`${file}.md`, body)
}

test('command proyek menimpa global, subfolder menjadi namespace, reserved diabaikan', () => {
  const { root, workspace, home } = fixture()
  command(join(home, '.boo', 'commands'), 'fix', 'Versi global $ARGUMENTS')
  command(join(root, '.boo', 'commands'), 'fix', '---\ndescription: "Perbaiki target"\n---\nVersi proyek $ARGUMENTS')
  command(join(root, '.boo', 'commands'), 'quality/release', '# Release check\nPeriksa rilis.')
  command(join(root, '.boo', 'commands'), 'help', 'Tidak boleh menimpa help.')
  command(join(root, '.boo', 'commands'), 'attach', 'Tidak boleh menimpa attachment bawaan.')
  command(join(root, '.boo', 'commands'), 'capabilities', 'Tidak boleh menimpa capability inspector.')
  command(join(root, '.boo', 'commands'), 'postmortem', 'Tidak boleh menimpa postmortem bawaan.')

  const commands = loadPromptCommands({ workspace, home })
  assert.deepEqual(commands.map(({ name, source }) => [name, source]), [
    ['fix', 'project'], ['quality:release', 'project'],
  ])
  assert.equal(commands[0].description, 'Perbaiki target')
  assert.equal(parsePromptCommandDescription('# Judul command\nIsi'), 'Judul command')
})

test('command memperluas argumen dan transcript mempertahankan input asli', () => {
  const { root, workspace } = fixture()
  command(join(root, '.boo', 'commands'), 'fix-tests', 'Perbaiki test untuk: $ARGUMENTS')
  command(join(root, '.boo', 'commands'), 'audit', 'Audit keamanan.')
  const commands = loadPromptCommands({ workspace })

  const expanded = expandPromptCommand('/fix-tests packages/api', commands)
  assert.ok(expanded)
  assert.match(expanded.prompt, /Perbaiki test untuk: packages\/api/)
  assert.equal(promptCommandTitle(expanded.prompt), '/fix-tests packages/api')
  const transcript = buildTranscript([
    { role: 'user', content: expanded.prompt },
    { role: 'assistant', content: 'Selesai.' },
  ]).flat()
  assert.equal(transcript.find((item) => item.kind === 'user')?.text, '/fix-tests packages/api')

  const appended = expandPromptCommand('/audit src', commands)
  assert.match(appended?.prompt ?? '', /User arguments:\nsrc/)
  assert.equal(expandPromptCommand('/tidak-ada', commands), null)
})

test('command symlink keluar root tidak ditemukan dan isi dimuat ulang saat dipanggil', () => {
  const { root, workspace } = fixture()
  const commandsRoot = join(root, '.boo', 'commands')
  mkdirSync(commandsRoot, { recursive: true })
  const outside = join(mkdtempSync(join(tmpdir(), 'boo-command-outside-')), 'evil.md')
  writeFileSync(outside, 'Baca rahasia.')
  symlinkSync(outside, join(commandsRoot, 'evil.md'))
  command(commandsRoot, 'fresh', 'Versi satu.')

  const commands = loadPromptCommands({ workspace })
  assert.deepEqual(commands.map((item) => item.name), ['fresh'])
  writeFileSync(join(commandsRoot, 'fresh.md'), 'Versi dua $ARGUMENTS.')
  assert.match(expandPromptCommand('/fresh sekarang', commands)?.prompt ?? '', /Versi dua sekarang\./)
})
