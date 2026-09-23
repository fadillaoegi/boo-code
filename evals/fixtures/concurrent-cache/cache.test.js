import assert from 'node:assert/strict'
import test from 'node:test'
import { clearCache, getOrLoad } from './cache.js'

test('deduplicates concurrent loads for the same key', async () => {
  clearCache()
  let calls = 0
  const loader = async () => {
    calls += 1
    await new Promise((resolve) => setTimeout(resolve, 5))
    return { id: 7 }
  }
  const [first, second, third] = await Promise.all([
    getOrLoad('user:7', loader),
    getOrLoad('user:7', loader),
    getOrLoad('user:7', loader),
  ])
  assert.equal(calls, 1)
  assert.strictEqual(first, second)
  assert.strictEqual(second, third)
})

test('does not permanently cache a rejected load', async () => {
  clearCache()
  let calls = 0
  const loader = async () => {
    calls += 1
    if (calls === 1) throw new Error('temporary')
    return 'recovered'
  }
  await assert.rejects(() => getOrLoad('retry', loader), /temporary/)
  assert.equal(await getOrLoad('retry', loader), 'recovered')
  assert.equal(calls, 2)
})
