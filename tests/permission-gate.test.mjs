import assert from 'node:assert/strict'
import { mkdtemp, mkdir, symlink, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import permissionGate from '../extensions/permission-gate.ts'

const ENV_KEYS = ['HOME', 'PI_PERMISSION_ROOT', 'PI_SUBAGENT_CHILD', 'PI_FIRSTMATE_WORKER']

async function withFixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'permission-gate-'))
  const home = path.join(root, 'home')
  const project = path.join(root, 'project')
  const globalPi = path.join(home, '.pi')
  await mkdir(globalPi, { recursive: true })
  await mkdir(project)

  const previous = new Map(ENV_KEYS.map((key) => [key, process.env[key]]))
  process.env.HOME = home
  delete process.env.PI_PERMISSION_ROOT
  delete process.env.PI_SUBAGENT_CHILD
  delete process.env.PI_FIRSTMATE_WORKER
  try {
    return await run({ home, project, globalPi })
  } finally {
    for (const key of ENV_KEYS) {
      const value = previous.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(root, { recursive: true, force: true })
  }
}

function createToolCall() {
  let handler
  const pi = {
    events: { emit() {} },
    on(event, callback) {
      if (event === 'tool_call') handler = callback
    },
    registerCommand() {},
    sendMessage() {},
  }
  permissionGate(pi)
  return async (toolName, filePath, context = {}) => handler(
    { toolName, input: { path: filePath } },
    {
      cwd: context.cwd,
      hasUI: context.hasUI ?? false,
      ui: { select: async () => context.choice ?? 'Block' },
    },
  )
}

test('allows an interactive non-sensitive read under the real global ~/.pi boundary', async () => {
  await withFixture(async ({ project, globalPi }) => {
    const filePath = path.join(globalPi, 'settings.json')
    await writeFile(filePath, '{}')
    const call = createToolCall()

    assert.equal(await call('read', filePath, { cwd: project }), undefined)
  })
})

test('keeps sensitive global ~/.pi reads behind the existing permission gate', async () => {
  await withFixture(async ({ project, globalPi }) => {
    const filePath = path.join(globalPi, 'credentials.json')
    await writeFile(filePath, '{}')
    const call = createToolCall()

    const result = await call('read', filePath, { cwd: project, hasUI: true, choice: 'Block' })
    assert.equal(result?.block, true)
  })
})

test('continues blocking global ~/.pi writes and edits', async () => {
  await withFixture(async ({ project, globalPi }) => {
    const call = createToolCall()
    for (const toolName of ['write', 'edit']) {
      const result = await call(toolName, path.join(globalPi, 'settings.json'), { cwd: project })
      assert.equal(result?.block, true, `${toolName} should remain guarded`)
    }
  })
})

test('blocks symlink escapes and global ~/.pi reads from headless subagents', async () => {
  await withFixture(async ({ project, globalPi }) => {
    const outside = path.join(path.dirname(globalPi), 'outside')
    await mkdir(outside)
    await writeFile(path.join(outside, 'outside.txt'), 'outside')
    await symlink(outside, path.join(globalPi, 'escape'))

    const call = createToolCall()
    const escaped = await call('read', path.join(globalPi, 'escape', 'outside.txt'), { cwd: project, hasUI: true, choice: 'Block' })
    assert.equal(escaped?.block, true)

    process.env.PI_SUBAGENT_CHILD = '1'
    const headlessCall = createToolCall()
    const headless = await headlessCall('read', path.join(globalPi, 'settings.json'), { cwd: project })
    assert.equal(headless?.block, true)
    assert.match(headless.reason, /headless subagent/)
  })
})
