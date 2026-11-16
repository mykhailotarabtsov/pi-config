import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { register } from 'node:module'

register('./ts-loader.mjs', import.meta.url)
register('./host-loader.mjs', import.meta.url)

const { discoverLoadedCounts } = await import('../extensions/startup/discovery.ts')
const { createSubagentEnvironment } = await import('../extensions/subagent/index.ts')

test('chain handoffs preserve both edges within the documented limit', async () => {
  const source = await readFile(new URL('../extensions/subagent/index.ts', import.meta.url), 'utf8')
  assert.match(source, /CHAIN_HANDOFF_MAX_CHARS = 12_000/)
  assert.match(source, /Previous output truncated: beginning and end preserved/)
  assert.match(source, /output\.slice\(0, headLength\)/)
  assert.match(source, /output\.slice\(-tailLength\)/)
  assert.match(source, /previousOutput = truncateChainHandoff\(getFinalOutput\(result\.messages\)\)/)
})

test('headless subagent environment removes coordinator identity and preserves agent capability provenance', async () => {
  const keys = ['HERDR_WORKSPACE_ID', 'PI_SUBAGENT_AGENT', 'PI_SUBAGENT_AGENT_SOURCE', 'PI_SUBAGENT_AGENT_DEFINITION', 'PI_PERMISSION_ROOT']
  const previous = new Map(keys.map((key) => [key, process.env[key]]))
  process.env.HERDR_WORKSPACE_ID = 'w-coordinator'
  process.env.PI_SUBAGENT_AGENT = 'old-agent'
  process.env.PI_SUBAGENT_AGENT_SOURCE = 'project'
  process.env.PI_SUBAGENT_AGENT_DEFINITION = '/old/definition.md'
  delete process.env.PI_PERMISSION_ROOT

  try {
    const env = createSubagentEnvironment('/tmp/pi-test-project', 'worker', 'user', 'agents/worker.md')
    assert.equal(env.PI_SUBAGENT_CHILD, '1')
    assert.equal(env.PI_SUBAGENT_AGENT, 'worker')
    assert.equal(env.PI_SUBAGENT_AGENT_SOURCE, 'user')
    assert.equal(env.PI_SUBAGENT_AGENT_DEFINITION, path.resolve('agents/worker.md'))
    assert.equal(env.PI_PERMISSION_ROOT, path.resolve('/tmp/pi-test-project'))
    assert.equal(env.PI_PERMISSION_NO_PUBLISH, '1')
    assert.equal(env.HERDR_WORKSPACE_ID, undefined)
  } finally {
    for (const key of keys) {
      const value = previous.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('startup counts use runtime command provenance and caller-supplied host metadata', () => {
  const commands = [
    { source: 'extension', name: 'startup' },
    { source: 'extension', name: 'permissions' },
    { source: 'skill', name: 'learn-codebase' },
    { source: 'skill', name: 'learn-codebase' },
    { source: 'prompt', name: 'review' },
    { source: 'prompt', name: 'review' },
    { source: 'built-in', name: 'help' },
  ]

  assert.deepEqual(discoverLoadedCounts(commands, { activeModel: 1, contextFiles: 2 }), {
    activeModel: 1,
    contextFiles: 2,
    extensionCommands: 2,
    skills: 1,
    promptTemplates: 1,
  })
})

test('startup mode tips reflect command availability', async () => {
  const index = await readFile(new URL('../extensions/startup/index.ts', import.meta.url), 'utf8')
  const layout = await readFile(new URL('../extensions/startup/layout.ts', import.meta.url), 'utf8')
  assert.match(index, /hasModeCommand\(commands, "chat-mode"\)/)
  assert.match(index, /hasModeCommand\(commands, "plan-mode"\)/)
  assert.match(layout, /if \(keyMap\["chat-mode\.toggle"\]\) tips\.push/)
  assert.match(layout, /if \(keyMap\["plan-mode\.toggle"\]\) tips\.push/)
})
