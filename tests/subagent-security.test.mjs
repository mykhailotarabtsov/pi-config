import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile, readFile, symlink } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { register } from 'node:module'

register('./ts-loader.mjs', import.meta.url)
register('./host-loader.mjs', import.meta.url)

const { default: permissionGate } = await import('../extensions/permission-gate.ts')
const { readSubagentTimeoutSeconds } = await import('../extensions/subagent/config.ts')
const subagentModule = await import('../extensions/subagent/index.ts')
const { discoverAgents } = await import('../extensions/subagent/agents.ts')
const subagent = subagentModule.default
const { createChildGroupTerminator, decodeUtf8Chunks } = subagentModule

const ENV_KEYS = [
  'HOME', 'PI_CODING_AGENT_DIR', 'PI_PERMISSION_ROOT', 'PI_SUBAGENT_CHILD', 'PI_SUBAGENT_AGENT',
  'PI_SUBAGENT_AGENT_SOURCE', 'PI_SUBAGENT_AGENT_DEFINITION', 'PI_FIRSTMATE_WORKER', 'PI_FIRSTMATE_TASK_ID',
  'PI_FIRSTMATE_REPORT_PATH', 'PI_PERMISSION_NO_PUBLISH', 'PI_PERMISSION_RESOURCE_ROOTS',
]

async function fixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'subagent-security-'))
  const project = path.join(root, 'project')
  const home = path.join(root, 'home')
  await mkdir(project)
  await mkdir(home)
  const previous = new Map(ENV_KEYS.map((key) => [key, process.env[key]]))
  process.env.HOME = home
  delete process.env.PI_PERMISSION_ROOT
  for (const key of ENV_KEYS.slice(2)) delete process.env[key]
  try { return await run({ root, project, home }) } finally {
    for (const key of ENV_KEYS) {
      const value = previous.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(root, { recursive: true, force: true })
  }
}

function harness(extra = {}) {
  const handlers = new Map()
  const selections = []
  const pi = {
    events: { emit() {} },
    on(name, handler) { handlers.set(name, handler) },
    registerCommand() {},
    sendMessage() {},
    getAllTools() { return extra.tools ?? [] },
  }
  permissionGate(pi)
  const context = (extra = {}) => ({
    cwd: extra.cwd,
    hasUI: extra.hasUI ?? false,
    ui: {
      select: async (prompt, options) => {
        selections.push({ prompt, options })
        return extra.choice ?? 'Block'
      },
      confirm: async (...args) => {
        selections.push({ confirm: args })
        return extra.confirm ?? false
      },
      notify() {},
    },
    isProjectTrusted: extra.isProjectTrusted,
    model: undefined,
  })
  return {
    selections,
    call(input, extra = {}) { return handlers.get('tool_call')({ toolName: input.toolName, input: input.input }, context(extra)) },
    bash(command, extra = {}) { return handlers.get('user_bash')({ command, cwd: extra.cwd }, context(extra)) },
  }
}

test('MCP scripts and direct MCP tools fail closed for headless children', async () => {
  await fixture(async ({ project }) => {
    process.env.PI_SUBAGENT_CHILD = '1'
    process.env.PI_SUBAGENT_AGENT = 'worker'
    const gate = harness()
    const script = await gate.call({ toolName: 'mcpScript', input: { script: 'call("browser", "navigate")' } }, { cwd: project })
    assert.equal(script?.block, true)
    const direct = await gate.call({ toolName: 'mcp__browser__navigate', input: { url: 'https://example.test' } }, { cwd: project })
    assert.equal(direct?.block, true)
  })
})

test('browser MCP bypass requires user-agent provenance, definition path, and an approved server', async () => {
  await fixture(async ({ project, home }) => {
    process.env.PI_SUBAGENT_CHILD = '1'
    process.env.PI_SUBAGENT_AGENT = 'browser-tester'
    const projectDefined = harness()
    assert.equal((await projectDefined.call({ toolName: 'mcp', input: { server: 'browser', tool: 'navigate' } }, { cwd: project }))?.block, true)

    const agentDir = path.join(home, '.pi', 'agent')
    const browserDefinition = path.join(agentDir, 'agents', 'browser-tester.md')
    await mkdir(path.dirname(browserDefinition), { recursive: true })
    await writeFile(browserDefinition, '---\nname: browser-tester\ndescription: browser QA\ntools: mcp__chrome-devtools__navigate\n---\n')
    process.env.PI_CODING_AGENT_DIR = agentDir
    process.env.PI_SUBAGENT_AGENT_SOURCE = 'user'
    process.env.PI_SUBAGENT_AGENT_DEFINITION = browserDefinition
    const userDefined = harness()
    assert.equal(await userDefined.call({ toolName: 'mcp__chrome-devtools__navigate', input: {} }, { cwd: project }), undefined)
    for (const input of [{}, { search: 'navigate' }, { connect: 'chrome-devtools' }, { tool: 'chrome-devtools_navigate_page', args: {} }, { server: 'chrome-devtools', tool: 'navigate_page' }]) {
      assert.equal(await userDefined.call({ toolName: 'mcp', input }, { cwd: project }), undefined)
    }
    for (const input of [{ connect: 'other' }, { tool: 'other_navigate_page' }, { action: 'auth-start', server: 'chrome-devtools' }]) {
      assert.equal((await userDefined.call({ toolName: 'mcp', input }, { cwd: project }))?.block, true)
    }

    const arbitraryDirect = harness({ tools: [{ name: 'browser_navigate', sourceInfo: { path: '/host/node_modules/pi-mcp-adapter/index.js' } }] })
    const blocked = await arbitraryDirect.call({ toolName: 'browser_navigate', input: {} }, { cwd: project })
    assert.equal(blocked?.block, true)

    const unknownChild = harness({ tools: [{ name: 'read' }] })
    assert.equal((await unknownChild.call({ toolName: 'unclassified_child_tool', input: {} }, { cwd: project }))?.block, true)

    delete process.env.PI_SUBAGENT_CHILD
    const interactive = harness({ tools: [{ name: 'browser_navigate', sourceInfo: { path: '/host/node_modules/pi-mcp-adapter/index.js' } }], choice: 'Allow once' })
    assert.equal(await interactive.call({ toolName: 'browser_navigate', input: {} }, { cwd: project, hasUI: true, choice: 'Allow once' }), undefined)
    assert.equal(interactive.selections.length, 1)
  })
})

test('Firstmate keeps ordinary boundary checks and only permits a validated report file', async () => {
  await fixture(async ({ project, home }) => {
    process.env.PI_FIRSTMATE_WORKER = '1'
    const gate = harness()
    const outside = await gate.call({ toolName: 'write', input: { path: path.join(home, 'unrelated.txt') } }, { cwd: project })
    assert.equal(outside?.block, true)

    const taskId = 'task-abc12345-def67890'
    const report = path.join(home, '.pi', 'firstmate', 'tasks', `${taskId}.report.json`)
    await mkdir(path.dirname(report), { recursive: true })
    process.env.PI_FIRSTMATE_TASK_ID = taskId
    process.env.PI_FIRSTMATE_REPORT_PATH = report
    const allowed = await gate.call({ toolName: 'write', input: { path: report } }, { cwd: project })
    assert.equal(allowed, undefined)

    process.env.PI_FIRSTMATE_REPORT_PATH = path.join(home, 'other.json')
    const invalid = await gate.call({ toolName: 'write', input: { path: process.env.PI_FIRSTMATE_REPORT_PATH } }, { cwd: project })
    assert.equal(invalid?.block, true)

    const arbitrary = path.join(home, 'arbitrary.txt')
    await writeFile(arbitrary, 'not a report')
    await rm(report, { force: true })
    await symlink(arbitrary, report)
    process.env.PI_FIRSTMATE_REPORT_PATH = report
    const symlinked = await gate.call({ toolName: 'write', input: { path: report } }, { cwd: project })
    assert.equal(symlinked?.block, true)
    await rm(arbitrary)
    assert.equal((await gate.call({ toolName: 'write', input: { path: report } }, { cwd: project }))?.block, true)
  })
})

test('headless children can read only realpath-allowlisted resources, never auth files', async () => {
  await fixture(async ({ project, home }) => {
    const skills = path.join(home, 'skills')
    await mkdir(skills)
    await writeFile(path.join(skills, 'guide.md'), 'trusted')
    process.env.PI_SUBAGENT_CHILD = '1'
    process.env.PI_PERMISSION_RESOURCE_ROOTS = skills
    const gate = harness()
    assert.equal(await gate.call({ toolName: 'read', input: { path: path.join(skills, 'guide.md') } }, { cwd: project }), undefined)
    const auth = await gate.call({ toolName: 'read', input: { path: path.join(home, 'auth.json') } }, { cwd: project })
    assert.equal(auth?.block, true)
  })
})

test('the no-publish identity blocks obvious publishing commands', async () => {
  await fixture(async ({ project }) => {
    process.env.PI_PERMISSION_NO_PUBLISH = '1'
    const gate = harness()
    const result = await gate.bash('npm publish', { cwd: project })
    assert.ok(result?.result)
    assert.match(result.result.output, /Publishing commands are blocked/)
  })
})

test('timeout settings are consumed only when finite and positive', async () => {
  await fixture(async ({ root }) => {
    const settings = path.join(root, 'settings.json')
    await writeFile(settings, JSON.stringify({ agents: { defaults: { timeoutSeconds: 17.9 } } }))
    assert.equal(readSubagentTimeoutSeconds(settings), 17)
    await writeFile(settings, JSON.stringify({ agents: { defaults: { timeoutSeconds: 0 } } }))
    assert.equal(readSubagentTimeoutSeconds(settings), 120)
    await writeFile(settings, JSON.stringify({ agents: { defaults: { timeoutSeconds: 'fast' } } }))
    assert.equal(readSubagentTimeoutSeconds(settings), 120)
  })
})

test('frontmatter tools arrays are executable and malformed fields fail closed', async () => {
  await fixture(async ({ project, home }) => {
    const agentDir = path.join(home, '.pi', 'agent')
    const projectAgents = path.join(project, '.pi', 'agents')
    await mkdir(projectAgents, { recursive: true })
    await writeFile(path.join(projectAgents, 'array.md'), '---\nname: array-agent\ndescription: array tools\ntools:\n  - read\n  - grep\n---\n')
    await writeFile(path.join(projectAgents, 'bad.md'), '---\nname: bad-agent\ndescription: malformed tools\ntools: 7\n---\n')
    process.env.PI_CODING_AGENT_DIR = agentDir
    const discovered = discoverAgents(project, 'project').agents
    assert.deepEqual(discovered.find((agent) => agent.name === 'array-agent')?.tools, ['read', 'grep'])
    assert.match(discovered.find((agent) => agent.name === 'bad-agent')?.toolsError ?? '', /comma-separated|string|array/i)
  })
})

test('subagent registration preserves native errors while normalizing details and usage', async () => {
  const handlers = new Map()
  const tools = []
  const pi = {
    on(name, handler) { handlers.set(name, handler) },
    registerTool(tool) { tools.push(tool) },
    registerCommand() {},
    getAllTools() { return [] },
  }
  subagent(pi)
  const tool = tools.find((entry) => entry.name === 'subagent')
  assert.ok(tool)
  await assert.rejects(
    tool.execute('failure-call', {}, undefined, undefined, { cwd: process.cwd(), hasUI: false, ui: {} }),
    /Invalid parameters/
  )
  const normalized = await handlers.get('tool_result')({ toolName: 'subagent', toolCallId: 'failure-call', isError: true })
  assert.ok(normalized.details)
  assert.equal(normalized.usage.totalTokens, 0)
  assert.equal(await handlers.get('tool_result')({ toolName: 'subagent', toolCallId: 'failure-call', isError: true }), undefined)
})

test('untrusted project agents cannot bypass confirmation with confirmProjectAgents:false', async () => {
  await fixture(async ({ project, home }) => {
    const agentDir = path.join(home, '.pi', 'agent')
    const projectAgents = path.join(project, '.pi', 'agents')
    await mkdir(projectAgents, { recursive: true })
    await writeFile(path.join(projectAgents, 'local.md'), '---\nname: local\ndescription: local\ntools: read\n---\n')
    process.env.PI_CODING_AGENT_DIR = agentDir
    const tools = []
    const pi = { on() {}, registerTool(tool) { tools.push(tool) }, registerCommand() {}, getAllTools() { return [] } }
    subagent(pi)
    const tool = tools.find((entry) => entry.name === 'subagent')
    await assert.rejects(
      tool.execute('trust-call', { agent: 'local', task: 'do not run', agentScope: 'project', confirmProjectAgents: false }, undefined, undefined, { cwd: project, hasUI: false, ui: {}, isProjectTrusted: () => false }),
      /trusted project.*cannot bypass trust/i,
    )
  })
})

test('UTF-8 stream decoding preserves bytes split between chunks', () => {
  assert.equal(decodeUtf8Chunks([Buffer.from([0xe2]), Buffer.from([0x82, 0xac]), Buffer.from(' ok')]), '€ ok')
})

async function processIsAlive(pid) {
  try {
    process.kill(pid, 0)
  } catch (error) {
    return error?.code !== 'ESRCH'
  }

  // Linux keeps a killed child visible as a zombie until its parent is
  // reaped. Treat that state as dead so this test checks for a live descendant,
  // not just the result of kill(pid, 0).
  if (process.platform === 'linux') {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
      const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3)
      return state !== 'Z'
    } catch (error) {
      return error?.code !== 'ENOENT'
    }
  }
  return true
}

async function waitForProcessDead(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await processIsAlive(pid))) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return !(await processIsAlive(pid))
}

test('abort kills descendants after the leader exits', { skip: process.platform === 'win32', timeout: 5_000 }, async () => {
  const leader = spawn(process.execPath, ['-e', [
    "const {spawn}=require('node:child_process')",
    "const child=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'})",
    "process.stdout.write(String(child.pid)); process.exit(0)",
  ].join(';')], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
  const [data] = await once(leader.stdout, 'data')
  const childPid = Number(String(data))
  assert.ok(Number.isInteger(childPid) && childPid > 0)
  try {
    const terminator = createChildGroupTerminator(leader, 100)
    terminator.requestStop()
    // The stdout data and close events can be delivered back-to-back. Do not
    // subscribe to close after the event has already been emitted.
    if (leader.exitCode === null && leader.signalCode === null) await once(leader, 'close')
    terminator.finish()
    assert.equal(await waitForProcessDead(childPid, 2_000), true)
  } finally {
    try { process.kill(childPid, 'SIGKILL') } catch {}
  }
})

test('subagent source keeps explicit tools and bounded-handoff safeguards visible', async () => {
  const source = await readFile(new URL('../extensions/subagent/index.ts', import.meta.url), 'utf8')
  assert.match(source, /--tools.*agent\.tools\.join/)
  assert.match(source, /MAX_CHAIN_STEPS = 8/)
  assert.match(source, /MAX_MESSAGE_BYTES/)
  assert.match(source, /StringDecoder/)
  assert.match(source, /MAX_STREAM_BUFFER_BYTES/)
  assert.match(source, /createChildGroupTerminator/)
  assert.match(source, /readSubagentTimeoutSeconds/)
  assert.match(source, /detached: process\.platform !== ["']win32["']/)
  assert.match(source, /nestedUsage/)
  assert.match(source, /isProjectTrusted/)
  assert.match(source, /throwToolFailure/)
  assert.match(source, /pi\.on\("tool_result"[\s\S]*?return failure \? \{ details: failure\.details, usage: failure\.usage \}/)
  assert.match(source, /PI_SUBAGENT_AGENT_DEFINITION/)
  const config = await readFile(new URL('../extensions/subagent/config.ts', import.meta.url), 'utf8')
  assert.match(config, /DEFAULT_SUBAGENT_TIMEOUT_SECONDS = 120/)
  assert.match(config, /agents\?\.defaults\?\.timeoutSeconds/)
})
