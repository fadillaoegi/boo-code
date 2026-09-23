import assert from 'node:assert/strict'
import test from 'node:test'
import { formatTag, formatUsername } from './src/index.js'

test('keeps the public username formatter behavior', () => {
  assert.equal(formatUsername('  Boo CODE!  '), 'boo-code')
})

test('keeps the public tag formatter behavior', () => {
  assert.equal(formatTag('  Agent Evals!  '), 'agent_evals')
})
