import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const root = mkdtempSync(join(tmpdir(), 'boo-web-permissions-'))
const home = join(root, 'home')
const workspace = join(root, 'workspace')
mkdirSync(join(home, '.boo'), { recursive: true })
mkdirSync(join(workspace, '.boo'), { recursive: true })
process.env.HOME = home
const { NineRouterProvider } = await import('@boo/core')
const { WebController } = await import('../src/server/controller.ts')

test('web menerapkan allow pribadi dan deny proyek tanpa membuka dialog approval', { timeout: 5_000 }, async () => {
  writeFileSync(join(home, '.boo', 'permissions.json'), JSON.stringify({
    version: 1,
    rules: [{ id: 'source', effect: 'allow', tool: 'write_file', path: 'src/**' }],
  }))
  writeFileSync(join(workspace, '.boo', 'permissions.json'), JSON.stringify({
    version: 1,
    rules: [{ id: 'generated', effect: 'deny', tool: 'write_file', path: 'src/generated/**' }],
  }))

  const provider = new NineRouterProvider({ baseUrl: 'http://unused.invalid', apiKey: 'fake', model: 'test-model' })
  let turn = 0
  provider.stream = async function* () {
    turn += 1
    if (turn === 1) {
      return {
        finishReason: 'tool_calls',
        message: {
          role: 'assistant' as const,
          content: null,
          tool_calls: [
            { id: 'allowed', type: 'function' as const, function: { name: 'write_file', arguments: JSON.stringify({ path: 'src/app.ts', content: 'export const ok = true\n' }) } },
            { id: 'denied', type: 'function' as const, function: { name: 'write_file', arguments: JSON.stringify({ path: 'src/generated/api.ts', content: 'export const unsafe = true\n' }) } },
          ],
        },
      }
    }
    const content = 'Selesai.'
    yield { type: 'text', delta: content }
    return { finishReason: 'stop', message: { role: 'assistant', content } }
  }
  const controller = new WebController({
    workspace,
    home,
    config: { BOO_MODEL: 'test-model' },
    version: 'test',
    createProvider: () => provider,
  })

  try {
    const done = new Promise<void>((resolve, reject) => {
      let started = false
      const unsubscribe = controller.subscribe((event) => {
        if (event.type === 'question' && event.question) {
          unsubscribe()
          reject(new Error(`Dialog approval tidak diharapkan: ${event.question.title}`))
        }
        if (event.type === 'busy' && event.busy) started = true
        if (event.type === 'busy' && !event.busy && started) {
          unsubscribe()
          resolve()
        }
      })
    })
    controller.submit('buat dua file')
    await done

    assert.equal(existsSync(join(workspace, 'src/app.ts')), true)
    assert.equal(existsSync(join(workspace, 'src/generated/api.ts')), false)
    const decisions = controller.snapshot().items
      .filter((item) => item.kind === 'decision')
      .map((item) => item.kind === 'decision' ? item.text : '')
    assert.ok(decisions.some((text) => /diizinkan oleh source/.test(text)), decisions.join('\n'))
    assert.ok(decisions.some((text) => /ditolak oleh generated/.test(text)), decisions.join('\n'))
  } finally {
    controller.close()
    rmSync(root, { recursive: true, force: true })
  }
})
