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
  const keys = ['HERDR_WORKSPACE_ID', 'PI_FIRSTMATE_ACTIVE', 'PI_SUBAGENT_AGENT', 'PI_SUBAGENT_AGENT_SOURCE', 'PI_SUBAGENT_AGENT_DEFINITION', 'PI_PERMISSION_ROOT']
  const previous = new Map(keys.map((key) => [key, process.env[key]]))
  process.env.HERDR_WORKSPACE_ID = 'w-coordinator'
  process.env.PI_FIRSTMATE_ACTIVE = '1'
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
    assert.equal(env.PI_FIRSTMATE_ACTIVE, undefined)
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

test('visible Firstmate worker tabs keep their Herdr environment path', async () => {
  const firstmate = await readFile(new URL('../extensions/firstmate/index.ts', import.meta.url), 'utf8')
  const subagent = await readFile(new URL('../extensions/subagent/index.ts', import.meta.url), 'utf8')

  assert.match(firstmate, /const tabArgs = \[/)
  assert.match(firstmate, /'tab', 'create'/)
  assert.match(firstmate, /const envArgs = \[\s*'pane',\s*'run'/)
  assert.doesNotMatch(firstmate, /createSubagentEnvironment/)
  assert.match(subagent, /env: createSubagentEnvironment\(defaultCwd, agent\.name, agent\.source, agent\.filePath\)/)
  assert.match(subagent, /process\.env\.PI_FIRSTMATE_ACTIVE === "1"/)
  assert.match(subagent, /delegated report/)
})

test('Firstmate delegates specialized browser work while keeping MCP exclusive to browser-tester', async () => {
  const firstmate = await readFile(new URL('../extensions/firstmate/index.ts', import.meta.url), 'utf8')
  const subagent = await readFile(new URL('../extensions/subagent/index.ts', import.meta.url), 'utf8')
  const permissionGate = await readFile(new URL('../extensions/permission-gate.ts', import.meta.url), 'utf8')
  const browserTester = await readFile(new URL('../agents/browser-tester.md', import.meta.url), 'utf8')

  assert.match(firstmate, /const ACTIVE_ENV = 'PI_FIRSTMATE_ACTIVE'/)
  assert.match(firstmate, /process\.env\[ACTIVE_ENV\] = '1'/)
  assert.match(firstmate, /delete process\.env\[ACTIVE_ENV\]/)
  assert.match(firstmate, /FIRSTMATE_ALLOWED_TOOLS/)
  assert.match(firstmate, /isFirstmateAllowedTool\(event\.toolName\)/)
  assert.match(firstmate, /agent: "browser-tester"/)
  assert.doesNotMatch(firstmate, /FIRSTMATE_ALLOWED_TOOLS = \[[^\]]*mcp/)
  assert.match(subagent, /PI_FIRSTMATE_ACTIVE === "1"/)
  assert.doesNotMatch(subagent, /Blocked: Firstmate delegates implementation work through visible Herdr worker tabs via herdr_control/)
  assert.match(subagent, /key\.startsWith\("HERDR_"\) \|\| key\.startsWith\("PI_FIRSTMATE_"\)/)
  assert.match(permissionGate, /const isTrustedBrowserTester = isSubagentChild\s*\n\s*&& process\.env\.PI_SUBAGENT_AGENT === "browser-tester"/)
  assert.match(permissionGate, /Firstmate delegates MCP browser work to the browser-tester agent/)
  assert.match(permissionGate, /if \(trustedBrowserMcp && event\.toolName !== "mcpScript"\) return undefined/)
  assert.match(permissionGate, /MCP tool blocked for headless subagent/)
  assert.match(browserTester, /tools: read, grep, find, ls, mcp/)
  assert.match(browserTester, /configured `chrome-devtools` MCP server/)
  assert.match(browserTester, /captain must sign in manually/)
  assert.match(browserTester, /never enter,\s*request, or automate credentials/i)
})
