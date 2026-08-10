import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { countContextFiles, countModels, countMcpServers } from '../extensions/startup/discovery.ts'

test('chain handoffs preserve both edges within the documented limit', async () => {
  const source = await readFile(new URL('../extensions/subagent/index.ts', import.meta.url), 'utf8')
  assert.match(source, /CHAIN_HANDOFF_MAX_CHARS = 12_000/)
  assert.match(source, /Previous output truncated: beginning and end preserved/)
  assert.match(source, /output\.slice\(0, headLength\)/)
  assert.match(source, /output\.slice\(-tailLength\)/)
  assert.match(source, /previousOutput = truncateChainHandoff\(getFinalOutput\(result\.messages\)\)/)
})

test('headless subagent environment removes Herdr and Firstmate identity only', async () => {
  const source = await readFile(new URL('../extensions/subagent/index.ts', import.meta.url), 'utf8')
  assert.match(source, /key\.startsWith\("HERDR_"\) \|\| key\.startsWith\("PI_FIRSTMATE_"\)/)
  assert.match(source, /env\.PI_SUBAGENT_CHILD = "1"/)
  assert.match(source, /env\.PI_PERMISSION_ROOT = process\.env\.PI_PERMISSION_ROOT \?\? path\.resolve\(defaultCwd\)/)
  assert.match(source, /env: createSubagentEnvironment\(defaultCwd\)/)
})

test('startup counts include default models, deduplicate context paths, and use the canonical MCP path', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'startup-counts-'))
  try {
    const agentDir = path.join(root, '.pi', 'agent')
    await mkdir(agentDir, { recursive: true })
    await writeFile(path.join(agentDir, 'AGENTS.md'), '# context')
    await writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultModel: 'default-model', enabledModels: ['enabled-model'] }))
    await writeFile(path.join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { one: {} } }))
    const project = path.join(root, 'project')
    await mkdir(path.join(project, '.pi'), { recursive: true })
    await writeFile(path.join(project, '.pi', 'settings.json'), JSON.stringify({ defaultModel: 'default-model', enabledModels: ['project-model'] }))

    assert.equal(countModels(root, project), 3)
    assert.equal(countContextFiles(root, agentDir), 1)
    assert.equal(countMcpServers(root), 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
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
  assert.match(firstmate, /const envArgs = \['pane', 'run'/)
  assert.doesNotMatch(firstmate, /createSubagentEnvironment/)
  assert.match(subagent, /env: createSubagentEnvironment\(defaultCwd\)/)
})
