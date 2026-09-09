import assert from 'node:assert/strict'
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const exec = promisify(execFile)
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function fixture(root, { old = true } = {}) {
  for (const directory of ['agents', 'skills', 'extensions', 'prompts', 'themes', 'scripts', 'tests']) {
    await mkdir(path.join(root, directory), { recursive: true })
  }
  for (const file of ['setup.sh', 'scripts/setup.mjs', 'models.json.template']) {
    await writeFile(path.join(root, file), await readFile(path.join(repo, file)))
  }
  await chmod(path.join(root, 'setup.sh'), 0o755)
  await chmod(path.join(root, 'scripts/setup.mjs'), 0o755)
  await writeFile(path.join(root, 'settings.json'), JSON.stringify({
    lastChangelogVersion: 'source-runtime-value',
    defaultModel: 'fixture-model',
    packages: [
      { source: '/source/machine/nono' },
      { source: '~/.config/nono/packages/pi' },
      '/source/machine/other-package',
      'npm:pi-mcp-adapter@2.26.1',
    ],
  }))
  await writeFile(path.join(root, 'mcp.json'), JSON.stringify({ mcpServers: { fixture: { command: 'fixture' } } }))
  await writeFile(path.join(root, 'APPEND_SYSTEM.md'), '# fixture\n')
  await writeFile(path.join(root, 'AGENTS.md'), '# agents\n')
  await writeFile(path.join(root, 'README.md'), '# setup\n')
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', private: true }))
  await writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ name: 'fixture', lockfileVersion: 3, requires: true, packages: {} }))
  await writeFile(path.join(root, 'agents/example.md'), 'agent\n')
  await writeFile(path.join(root, 'skills/example.md'), 'skill\n')
  await writeFile(path.join(root, 'extensions/current.ts'), 'export const current = 1\n')
  await writeFile(path.join(root, 'extensions/herdr-agent-state.ts'), 'machine state\n')
  await writeFile(path.join(root, 'extensions/disabled.ts.disabled'), 'disabled\n')
  await writeFile(path.join(root, 'prompts/example.md'), 'prompt\n')
  await writeFile(path.join(root, 'themes/example.json'), '{}\n')
  if (old) await writeFile(path.join(root, 'extensions/old.ts'), 'old\n')
}

async function fakeNpm(root) {
  const bin = path.join(root, 'bin')
  const log = path.join(root, 'npm.log')
  await mkdir(bin, { recursive: true })
  await writeFile(path.join(bin, 'npm'), '#!/bin/sh\nif [ "$1" != "--version" ]; then printf "%s\\n" "$*" >> "$FAKE_NPM_LOG"; else echo 10.0.0; fi\nexit 0\n')
  await chmod(path.join(bin, 'npm'), 0o755)
  return { bin, log }
}

async function runSetup(source, target, npm, args = [], env = {}) {
  const result = await exec(process.execPath, [path.join(source, 'scripts/setup.mjs'), '--source', source, '--target', target, ...args], {
    cwd: os.tmpdir(),
    env: { ...process.env, PATH: `${npm.bin}:${process.env.PATH}`, FAKE_NPM_LOG: npm.log, ...env },
    maxBuffer: 1024 * 1024,
  })
  return result.stdout
}

async function runSetupFailure(source, target, npm, args = [], env = {}) {
  await assert.rejects(
    runSetup(source, target, npm, args, env),
    (error) => error && error.code !== undefined,
  )
}

test('fresh, repeat, stale pruning, backups, and preservation are safe', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-setup-'))
  try {
    const source = path.join(root, 'source')
    const target = path.join(root, 'target')
    await mkdir(source)
    await fixture(source)
    const npm = await fakeNpm(root)

    await runSetup(source, target, npm)
    const settingsBefore = await readFile(path.join(target, 'settings.json'))
    const mcpBefore = await readFile(path.join(target, 'mcp.json'))
    assert.deepEqual(JSON.parse(await readFile(path.join(target, 'models.json'))), { providers: {} })
    assert.doesNotMatch(await readFile(path.join(target, 'settings.json'), 'utf8'), /lastChangelogVersion|nono/)
    assert.match(await readFile(path.join(target, 'settings.json'), 'utf8'), /npm:pi-mcp-adapter@2\.26\.1/)
    await runSetup(source, target, npm)
    assert.deepEqual(JSON.parse(await readFile(path.join(target, 'models.json'))), { providers: {} })
    await assert.rejects(stat(path.join(target, 'extensions/herdr-agent-state.ts')))
    await assert.rejects(stat(path.join(target, 'extensions/disabled.ts.disabled')))
    await writeFile(path.join(target, 'auth.json'), 'secret')
    await mkdir(path.join(target, 'sessions'))
    await writeFile(path.join(target, 'sessions/session'), 'keep')
    await writeFile(path.join(target, 'settings.json'), '{"custom":true}\n')
    await writeFile(path.join(target, 'mcp.json'), '{"custom":true}\n')
    await writeFile(path.join(target, 'models.json'), '{"providers":{"custom":{}}}\n')
    await writeFile(path.join(source, 'extensions/current.ts'), 'export const current = 2\n')
    await runSetup(source, target, npm)
    assert.equal(await readFile(path.join(target, 'settings.json'), 'utf8'), '{"custom":true}\n')
    assert.equal(await readFile(path.join(target, 'mcp.json'), 'utf8'), '{"custom":true}\n')
    assert.equal(await readFile(path.join(target, 'models.json'), 'utf8'), '{"providers":{"custom":{}}}\n')
    assert.equal(await readFile(path.join(target, 'auth.json'), 'utf8'), 'secret')
    assert.equal(await readFile(path.join(target, 'sessions/session'), 'utf8'), 'keep')
    assert.equal(await readFile(path.join(target, 'extensions/current.ts'), 'utf8'), 'export const current = 2\n')
    assert.notEqual((await readdir(path.join(target, '.pi-agent-backups'), { recursive: true })).length, 0)

    await rm(path.join(source, 'extensions/old.ts'))
    await runSetup(source, target, npm)
    await assert.rejects(stat(path.join(target, 'extensions/old.ts')))
    await writeFile(path.join(source, 'extensions/old.ts'), 'old again\n')
    await runSetup(source, target, npm)
    await writeFile(path.join(target, 'extensions/old.ts'), 'user edit\n')
    await rm(path.join(source, 'extensions/old.ts'))
    const output = await runSetup(source, target, npm)
    assert.match(output, /modified obsolete managed file: extensions\/old\.ts/)
    assert.equal(await readFile(path.join(target, 'extensions/old.ts'), 'utf8'), 'user edit\n')
    assert.ok(!JSON.parse(await readFile(path.join(target, '.pi-agent-managed.json'))).files['extensions/old.ts'])
    await rm(path.join(source, 'extensions/current.ts'))
    await symlink(path.join(root, 'external.ts'), path.join(source, 'extensions/current.ts'))
    await runSetup(source, target, npm)
    assert.equal(await readFile(path.join(target, 'extensions/current.ts'), 'utf8'), 'export const current = 2\n')
    assert.equal(settingsBefore.length > 0, true)
    assert.equal(mcpBefore.length > 0, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('llama URL is validated and updates only its provider with JSON-safe escaping', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-models-'))
  try {
    const source = path.join(root, 'source')
    const target = path.join(root, 'target')
    await mkdir(source)
    await fixture(source, { old: false })
    await mkdir(target, { recursive: true })
    await writeFile(path.join(target, 'models.json'), JSON.stringify({ providers: { custom: { api: 'keep' } } }))
    const npm = await fakeNpm(root)
    await runSetup(source, target, npm, [], { PI_LLAMA_CPP_URL: 'https://gpu.example/v1?q=a&x=1' })
    const models = JSON.parse(await readFile(path.join(target, 'models.json')))
    assert.deepEqual(models.providers.custom, { api: 'keep' })
    assert.equal(models.providers['llama-cpp'].baseUrl, 'https://gpu.example/v1?q=a&x=1')
    assert.equal(models.providers['llama-cpp'].timeout, undefined)
    assert.equal(models.providers['llama-cpp'].models[0].tools, undefined)
    assert.notEqual((await readdir(path.join(target, '.pi-agent-backups'), { recursive: true })).length, 0)

    const invalidTarget = path.join(root, 'invalid-target')
    await runSetupFailure(source, invalidTarget, npm, [], { PI_LLAMA_CPP_URL: 'not a URL' })
    await assert.rejects(stat(invalidTarget))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('root setup works from an arbitrary caller cwd and dry-run makes no target writes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-dry-run-'))
  try {
    const source = path.join(root, 'source')
    const target = path.join(root, 'target')
    await mkdir(source)
    await fixture(source, { old: false })
    const npm = await fakeNpm(root)
    await exec(path.join(source, 'setup.sh'), ['--target', target, '--dry-run'], {
      cwd: '/',
      env: { ...process.env, PATH: `${npm.bin}:${process.env.PATH}`, FAKE_NPM_LOG: npm.log },
    })
    await assert.rejects(stat(target))
    await assert.rejects(stat(npm.log))
    await runSetup(source, target, npm)
    assert.ok(await stat(path.join(target, '.pi-agent-managed.json')))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('in-place setup does not copy into or prune its own source', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-in-place-'))
  try {
    const source = path.join(root, 'source')
    await mkdir(source)
    await fixture(source, { old: false })
    await writeFile(path.join(source, 'extensions/obsolete.ts'), 'keep me')
    await writeFile(path.join(source, '.pi-agent-managed.json'), JSON.stringify({ version: 1, files: { 'extensions/obsolete.ts': 'f'.repeat(64) } }))
    const npm = await fakeNpm(root)
    await runSetup(source, source, npm)
    assert.equal(await readFile(path.join(source, 'extensions/obsolete.ts'), 'utf8'), 'keep me')
    assert.equal((await readFile(npm.log, 'utf8')).split('\n').filter(Boolean).length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('symlink traversal in managed target directories is rejected before writes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-symlink-'))
  try {
    const source = path.join(root, 'source')
    const target = path.join(root, 'target')
    const outside = path.join(root, 'outside')
    await mkdir(source)
    await fixture(source, { old: false })
    await mkdir(outside)
    await mkdir(target)
    await symlink(outside, path.join(target, 'extensions'))
    const npm = await fakeNpm(root)
    await runSetupFailure(source, target, npm)
    await assert.rejects(stat(path.join(target, '.pi-agent-managed.json')))
    await assert.rejects(stat(path.join(outside, 'current.ts')))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('unowned conflicts are preserved and model backups remain private', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-setup-conflict-'))
  try {
    const source = path.join(root, 'source')
    const target = path.join(root, 'target')
    await mkdir(source)
    await fixture(source)
    await mkdir(path.join(target, 'extensions'), { recursive: true })
    await writeFile(path.join(target, 'extensions/current.ts'), 'user-owned')
    await writeFile(path.join(target, 'models.json'), '{"providers":{"custom":{}}}', { mode: 0o644 })
    const npm = await fakeNpm(root)
    const output = await runSetup(source, target, npm, [], { PI_LLAMA_CPP_URL: 'https://gpu.example/v1' })
    assert.match(output, /Preserving conflicting unowned file/)
    assert.equal(await readFile(path.join(target, 'extensions/current.ts'), 'utf8'), 'user-owned')
    assert.equal(JSON.parse(await readFile(path.join(target, '.pi-agent-managed.json'))).files['extensions/current.ts'], undefined)
    assert.equal((await stat(path.join(target, 'models.json'))).mode & 0o777, 0o600)
    const backups = await readdir(path.join(target, '.pi-agent-backups'), { recursive: true })
    const modelBackup = backups.find(file => file.endsWith('models.json'))
    assert.equal((await stat(path.join(target, '.pi-agent-backups', modelBackup))).mode & 0o777, 0o600)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

