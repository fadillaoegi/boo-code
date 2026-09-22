import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  evaluatePermission,
  loadPermissionPolicy,
  parsePermissionRules,
  permissionRuleLabel,
  resolveConfiguredPermission,
} from '../src/agent/permissions.ts'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'boo-permissions-'))
  const home = join(root, 'home')
  const workspace = join(root, 'workspace')
  mkdirSync(join(home, '.boo'), { recursive: true })
  mkdirSync(join(workspace, '.boo'), { recursive: true })
  return { home, workspace }
}

test('parser memvalidasi aturan dan repository tidak dapat memberi auto-allow', () => {
  const parsed = parsePermissionRules({
    version: 1,
    rules: [
      { id: 'protect', effect: 'deny', tool: '*', path: '**/.env' },
      { id: 'untrusted', effect: 'allow', tool: 'bash', command: 'pnpm test' },
      { id: 'broken', effect: 'sometimes', tool: 'bash' },
    ],
  }, 'project', '.boo/permissions.json')

  assert.deepEqual(parsed.rules.map((rule) => rule.id), ['protect'])
  assert.match(parsed.issues.join('\n'), /untrusted.*repository hanya boleh/i)
  assert.match(parsed.issues.join('\n'), /effect atau pola tool tidak sah/)
})

test('deny menang atas ask dan allow; kondisi command, path, app, dan domain dicocokkan', () => {
  const { home, workspace } = fixture()
  writeFileSync(join(home, '.boo', 'permissions.json'), JSON.stringify({
    version: 1,
    rules: [
      { id: 'commands', effect: 'allow', tool: 'bash', command: 'pnpm *' },
      { id: 'no-release', effect: 'deny', tool: 'bash', command: 'pnpm publish*' },
      { id: 'source', effect: 'allow', tool: 'write_file', path: 'src/**' },
      { id: 'secrets', effect: 'deny', tool: '*', path: '**/.env' },
      { id: 'editor', effect: 'allow', tool: 'open_app', app: 'editor' },
      { id: 'docs', effect: 'ask', tool: 'browser_*', domain: '*.example.com' },
    ],
  }))
  writeFileSync(join(workspace, '.boo', 'permissions.json'), JSON.stringify({
    version: 1,
    rules: [
      { id: 'confirm-tests', effect: 'ask', tool: 'bash', command: 'pnpm test' },
      { id: 'protect-generated', effect: 'deny', tool: '*_file', path: 'src/generated/**' },
    ],
  }))
  const policy = loadPermissionPolicy({ home, workspace })

  assert.equal(evaluatePermission(policy, { tool: 'bash', args: { command: 'pnpm lint' } })?.effect, 'allow')
  assert.equal(evaluatePermission(policy, { tool: 'bash', args: { command: 'pnpm test' } })?.rule.id, 'confirm-tests')
  assert.equal(evaluatePermission(policy, { tool: 'bash', args: { command: 'pnpm publish --tag next' } })?.rule.id, 'no-release')
  assert.equal(evaluatePermission(policy, { tool: 'write_file', args: { path: 'src/app.ts' } })?.rule.id, 'source')
  assert.equal(evaluatePermission(policy, { tool: 'write_file', args: { path: 'src/generated/api.ts' } })?.rule.id, 'protect-generated')
  assert.equal(evaluatePermission(policy, { tool: 'write_file', args: { path: '.env' } })?.rule.id, 'secrets')
  assert.equal(evaluatePermission(policy, { tool: 'write_file', args: { path: 'config/.env' } })?.rule.id, 'secrets')
  assert.equal(evaluatePermission(policy, { tool: 'open_app', args: { id: 'EDITOR' } })?.rule.id, 'editor')
  assert.equal(evaluatePermission(policy, { tool: 'browser_open', args: { url: 'https://docs.example.com/guide' } })?.rule.id, 'docs')
  assert.equal(evaluatePermission(policy, { tool: 'browser_open', args: { url: 'https://example.com.evil.test/' } }), null)
  assert.equal(evaluatePermission(policy, { tool: 'bash', args: { command: 'npm test' } }), null)
})

test('allow path untuk patch hanya cocok bila seluruh file berada dalam cakupan', () => {
  const parsed = parsePermissionRules({
    version: 1,
    rules: [{ id: 'source-patch', effect: 'allow', tool: 'apply_patch', path: 'src/**' }],
  }, 'global', '~/.boo/permissions.json')
  const policy = {
    rules: parsed.rules,
    issues: parsed.issues,
    globalPath: '/home/.boo/permissions.json',
    projectPath: '/repo/.boo/permissions.json',
  }
  const sourceOnly = '*** Begin Patch\n*** Update File: src/a.ts\n*** Add File: src/b.ts\n*** End Patch'
  const mixed = '*** Begin Patch\n*** Update File: src/a.ts\n*** Update File: docs/a.md\n*** End Patch'
  assert.equal(evaluatePermission(policy, { tool: 'apply_patch', args: { patch: sourceOnly } })?.effect, 'allow')
  assert.equal(evaluatePermission(policy, { tool: 'apply_patch', args: { patch: mixed } }), null)
})

test('katalog melaporkan JSON rusak dan label tidak memuat argumen tindakan', () => {
  const { home, workspace } = fixture()
  writeFileSync(join(home, '.boo', 'permissions.json'), '{rusak')
  const policy = loadPermissionPolicy({ home, workspace })
  assert.equal(policy.rules.length, 0)
  assert.match(policy.issues.join('\n'), /JSON tidak valid/)

  const parsed = parsePermissionRules({ version: 1, rules: [{ id: 'tests', effect: 'allow', tool: 'bash', command: 'pnpm test' }] }, 'global', 'global')
  assert.equal(permissionRuleLabel(parsed.rules[0]!), 'tests: allow · tool=bash · command=pnpm test [global]')
})

test('allow tidak melewati fresh approval maupun command sandbox yang tidak enforced', () => {
  const parsed = parsePermissionRules({ version: 1, rules: [{ id: 'allowed', effect: 'allow', tool: '*' }] }, 'global', 'global')
  const match = { effect: 'allow' as const, rule: parsed.rules[0]! }
  assert.equal(resolveConfiguredPermission(match, { allowAlways: false, commandAction: false }), 'ask')
  assert.equal(resolveConfiguredPermission(match, { allowAlways: true, commandAction: true, sandbox: { enforced: false, mode: 'workspace-write' } }), 'ask')
  assert.equal(resolveConfiguredPermission(match, { allowAlways: true, commandAction: true, sandbox: { enforced: true, mode: 'danger-full-access' } }), 'ask')
  assert.equal(resolveConfiguredPermission(match, { allowAlways: true, commandAction: true, sandbox: { enforced: true, mode: 'workspace-write' } }), 'allow')
  assert.equal(resolveConfiguredPermission(match, { allowAlways: true, commandAction: false }), 'allow')
})

test('symlink konfigurasi proyek yang keluar workspace ditolak', { skip: process.platform === 'win32' }, () => {
  const { home, workspace } = fixture()
  const outside = join(home, 'outside.json')
  writeFileSync(outside, JSON.stringify({ version: 1, rules: [{ effect: 'deny', tool: '*' }] }))
  symlinkSync(outside, join(workspace, '.boo', 'permissions.json'))
  const policy = loadPermissionPolicy({ home, workspace })
  assert.equal(policy.rules.length, 0)
  assert.match(policy.issues.join('\n'), /di luar root ditolak/)
})
