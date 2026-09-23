import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadRemoteNodes } from '@boo/core'
import { runNodeCommand } from '../src/node.ts'

test('CLI node memasangkan dan menghapus device tanpa mencetak ulang token', async () => {
  const home = mkdtempSync(join(tmpdir(), 'boo-cli-node-'))
  const token = 'a'.repeat(43)
  const output: string[] = []
  const original = console.log
  console.log = (...values: unknown[]) => { output.push(values.join(' ')) }
  try {
    assert.equal(await runNodeCommand(['pair', '--id', 'laptop', '--label', 'Laptop', '--url', 'http://127.0.0.1:7443', '--token', token], home), 0)
    assert.equal(loadRemoteNodes(home).nodes.length, 1)
    assert.equal(await runNodeCommand(['list'], home), 0)
    assert.equal(await runNodeCommand(['remove', 'laptop'], home), 0)
  } finally { console.log = original }
  assert.doesNotMatch(output.join('\n'), new RegExp(token))
})

test('CLI node menolak HTTP remote non-loopback', async () => {
  const home = mkdtempSync(join(tmpdir(), 'boo-cli-node-'))
  assert.equal(await runNodeCommand(['pair', '--id', 'x', '--url', 'http://192.168.1.5:7443', '--token', 'a'.repeat(43)], home), 2)
  assert.equal(loadRemoteNodes(home).nodes.length, 0)
})
