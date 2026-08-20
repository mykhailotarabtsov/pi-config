import assert from 'node:assert/strict'
import { mkdtemp, mkdir, symlink, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import permissionGate from '../extensions/permission-gate.ts'
import { permissionsSegment } from '../extensions/footer/segments/permissions.ts'

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

function createHarness() {
  const handlers = new Map()
  let commandHandler
  const selections = []
  const messages = []
  const pi = {
    events: { emit() {} },
    on(event, callback) {
      handlers.set(event, callback)
    },
    registerCommand(name, command) {
      if (name === 'permissions') commandHandler = command.handler
    },
    sendMessage(message) {
      messages.push(message)
    },
  }
  permissionGate(pi)

  function contextFor(context = {}) {
    return {
      cwd: context.cwd,
      hasUI: context.hasUI ?? false,
      ui: {
        select: async (prompt, options) => {
          selections.push({ prompt, options })
          return context.choice ?? 'Block'
        },
        notify() {},
      },
    }
  }

  return {
    async callTool(toolName, input, context = {}) {
      return handlers.get('tool_call')({ toolName, input }, contextFor(context))
    },
    async callBash(command, context = {}) {
      return handlers.get('user_bash')({ command, cwd: context.cwd }, contextFor(context))
    },
    async permissions(args = '', context = {}) {
      return commandHandler(args, contextFor({ ...context, hasUI: true }))
    },
    async startSession() {
      return handlers.get('session_start')({}, contextFor())
    },
    async shutdown() {
      return handlers.get('session_shutdown')({}, {})
    },
    selections,
    messages,
  }
}

function createToolCall() {
  const harness = createHarness()
  return async (toolName, filePath, context = {}) => harness.callTool(toolName, { path: filePath }, context)
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

test('allows selected safe file operations for the rest of the session', async () => {
  await withFixture(async ({ home, project }) => {
    const harness = createHarness()
    const outsideFile = path.join(home, 'notes.txt')
    const choice = 'Allow safe operations for this session'

    assert.equal(await harness.callTool('read', { path: outsideFile }, { cwd: project, hasUI: true, choice }), undefined)
    assert.ok(harness.selections[0].options.includes(choice))
    assert.equal(await harness.callTool('write', { path: path.join(home, 'write.txt') }, { cwd: project }), undefined)
    assert.equal(await harness.callTool('edit', { path: path.join(home, 'edit.txt') }, { cwd: project }), undefined)
    for (const toolName of ['grep', 'find', 'ls']) {
      assert.equal(await harness.callTool(toolName, { path: outsideFile }, { cwd: project }), undefined)
    }

    await harness.permissions('', { cwd: project })
    assert.match(harness.messages.at(-1).content, /Safe operations for this session: enabled/)
  })
})

test('allows selected safe Bash outside the project but keeps sensitive and dangerous requests guarded', async () => {
  await withFixture(async ({ home, project }) => {
    const harness = createHarness()
    const choice = 'Allow safe operations for this session'
    const outsideCommand = `cat ${path.join(home, 'notes.txt')}`

    assert.equal(await harness.callBash(outsideCommand, { cwd: project, hasUI: true, choice }), undefined)
    assert.ok(harness.selections[0].options.includes(choice))
    assert.equal(await harness.callBash(`cat ${path.join(home, 'other.txt')}`, { cwd: project }), undefined)

    const sensitive = await harness.callBash(`cat ${path.join(home, 'Library', 'Keychains', 'login.keychain-db')}`, { cwd: project })
    assert.ok(sensitive?.result)
    assert.match(sensitive.result.output, /sensitive/)

    const dangerous = await harness.callBash(`rm -rf ${path.join(home, 'destroy-me')}`, { cwd: project, hasUI: true, choice })
    assert.ok(dangerous?.result)
    assert.ok(!harness.selections.at(-1).options.includes(choice))
  })
})

test('safe mode keeps system-security file reads guarded without offering safe mode', async () => {
  await withFixture(async ({ home, project }) => {
    const harness = createHarness()
    const choice = 'Allow safe operations for this session'
    await harness.callTool('read', { path: path.join(home, 'notes.txt') }, { cwd: project, hasUI: true, choice })

    const directPaths = [
      '/etc/passwd',
      '/private/etc/sudoers',
      '/private/var/db/dslocal/nodes/Default/users/root.plist',
      '/var/root/.ssh/authorized_keys',
      '/Library/Keychains/System.keychain',
      path.join(home, 'Library', 'Application Support', 'com.apple.TCC', 'TCC.db'),
    ]
    for (const filePath of directPaths) {
      const result = await harness.callTool('read', { path: filePath }, { cwd: project, hasUI: true, choice })
      assert.equal(result?.block, true, `${filePath} should remain guarded`)
      assert.ok(!harness.selections.at(-1).options.includes(choice), `${filePath} must not offer safe mode`)
    }

    for (const toolName of ['grep', 'find', 'ls']) {
      for (const filePath of directPaths) {
        const result = await harness.callTool(toolName, { path: filePath }, { cwd: project, hasUI: true, choice })
        assert.equal(result?.block, true, `${toolName} ${filePath} should remain guarded`)
        assert.ok(!harness.selections.at(-1).options.includes(choice), `${toolName} ${filePath} must not offer safe mode`)
      }
    }

    const bashPaths = [
      '/etc/passwd',
      '/private/etc/ssh/ssh_config',
      '/private/var/db/dslocal/nodes/Default/users/root.plist',
      '/var/root/.ssh/authorized_keys',
      '/Library/Keychains/System.keychain',
      path.join(home, 'Library', 'Application Support', 'com.apple.TCC', 'TCC.db'),
    ]
    for (const filePath of bashPaths) {
      const result = await harness.callBash(`cat '${filePath}'`, { cwd: project, hasUI: true, choice })
      assert.ok(result?.result, `${filePath} should remain guarded in Bash`)
      assert.match(harness.selections.at(-1).prompt, /Sensitive-path Bash command/)
      assert.ok(!harness.selections.at(-1).options.includes(choice), `${filePath} must not offer safe mode in Bash`)
    }

    for (const command of [
      "grep passwd '/etc/passwd'",
      "find '/private/etc' -name passwd",
      "ls '/private/var/db'",
    ]) {
      const result = await harness.callBash(command, { cwd: project, hasUI: true, choice })
      assert.ok(result?.result, `${command} should remain guarded in Bash`)
      assert.match(harness.selections.at(-1).prompt, /Sensitive-path Bash command/)
      assert.ok(!harness.selections.at(-1).options.includes(choice), `${command} must not offer safe mode`)
    }
  })
})

test('defaults omitted grep/find/ls paths to the current project directory', async () => {
  await withFixture(async ({ project }) => {
    const harness = createHarness()
    for (const toolName of ['grep', 'find', 'ls']) {
      assert.equal(await harness.callTool(toolName, {}, { cwd: project }), undefined)
    }
  })
})

test('safe mode does not allow node_modules mutations or symlink escapes', async () => {
  await withFixture(async ({ home, project }) => {
    const outside = path.join(home, 'outside')
    await mkdir(outside)
    await writeFile(path.join(outside, 'outside.txt'), 'outside')
    await symlink(outside, path.join(project, 'escape'))
    const harness = createHarness()
    const choice = 'Allow safe operations for this session'

    assert.equal(await harness.callTool('read', { path: path.join(home, 'seed.txt') }, { cwd: project, hasUI: true, choice }), undefined)
    const nodeModules = await harness.callTool('write', { path: path.join(home, 'node_modules', 'package', 'index.js') }, { cwd: project })
    assert.equal(nodeModules?.block, true)
    const escaped = await harness.callTool('read', { path: path.join(project, 'escape', 'outside.txt') }, { cwd: project })
    assert.equal(escaped?.block, true)
    const escapedBash = await harness.callBash(`cat ${path.join(project, 'escape', 'outside.txt')}`, { cwd: project })
    assert.ok(escapedBash?.result)
  })
})

test('permissions clear and session shutdown reset safe operations', async () => {
  await withFixture(async ({ home, project }) => {
    const choice = 'Allow safe operations for this session'
    const harness = createHarness()
    await harness.callTool('read', { path: path.join(home, 'seed.txt') }, { cwd: project, hasUI: true, choice })
    await harness.permissions('clear', { cwd: project })
    const afterClear = await harness.callTool('read', { path: path.join(home, 'after-clear.txt') }, { cwd: project })
    assert.equal(afterClear?.block, true)
    await harness.callTool('read', { path: path.join(home, 're-enable.txt') }, { cwd: project, hasUI: true, choice })
    await harness.shutdown()
    const afterShutdown = await harness.callTool('read', { path: path.join(home, 'after-shutdown.txt') }, { cwd: project })
    assert.equal(afterShutdown?.block, true)

    const statusHarness = createHarness()
    await statusHarness.permissions('', { cwd: project })
    assert.match(statusHarness.messages.at(-1).content, /Safe operations for this session: disabled/)
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

test('renders permission status as guarded by default and safe when enabled', () => {
  const previousState = globalThis.__permissionGate
  const theme = { fg: (name, text) => `<${name}>${text}</${name}>` }
  const context = { theme, colors: { modeIndicator: 'warning' } }

  try {
    delete globalThis.__permissionGate
    const guarded = permissionsSegment.render(context)
    assert.equal(guarded.visible, true)
    assert.match(guarded.content, /Permissions:/)
    assert.match(guarded.content, /GUARDED/)
    assert.doesNotMatch(guarded.content, /\.env|secret|token|command|path/i)

    globalThis.__permissionGate = { safeOperationsEnabled: true }
    const safe = permissionsSegment.render(context)
    assert.match(safe.content, /Permissions:/)
    assert.match(safe.content, /SAFE/)
  } finally {
    if (previousState === undefined) delete globalThis.__permissionGate
    else globalThis.__permissionGate = previousState
  }
})

test('publishes permission state and rerenders on session-safe transitions', async () => {
  await withFixture(async ({ home, project }) => {
    const previousState = globalThis.__permissionGate
    const previousRenderHook = globalThis.__footerRequestRender
    let renderRequests = 0
    globalThis.__footerRequestRender = () => { renderRequests += 1 }

    try {
      const harness = createHarness()
      assert.deepEqual(globalThis.__permissionGate, { safeOperationsEnabled: false })
      await harness.startSession()
      assert.deepEqual(globalThis.__permissionGate, { safeOperationsEnabled: false })

      const choice = 'Allow safe operations for this session'
      await harness.callTool('read', { path: path.join(home, 'safe.txt') }, { cwd: project, hasUI: true, choice })
      assert.deepEqual(globalThis.__permissionGate, { safeOperationsEnabled: true })
      assert.equal(renderRequests, 1)

      await harness.permissions('clear', { cwd: project })
      assert.deepEqual(globalThis.__permissionGate, { safeOperationsEnabled: false })
      assert.equal(renderRequests, 2)

      await harness.callTool('read', { path: path.join(home, 'safe-again.txt') }, { cwd: project, hasUI: true, choice })
      await harness.shutdown()
      assert.deepEqual(globalThis.__permissionGate, { safeOperationsEnabled: false })
      assert.equal(renderRequests, 4)
    } finally {
      if (previousState === undefined) delete globalThis.__permissionGate
      else globalThis.__permissionGate = previousState
      if (previousRenderHook === undefined) delete globalThis.__footerRequestRender
      else globalThis.__footerRequestRender = previousRenderHook
    }
  })
})
