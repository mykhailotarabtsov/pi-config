import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { register } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

register('./ts-loader.mjs', import.meta.url)

test('artifact config is silent when absent and warns without values when malformed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-artifact-config-'))
  const previousDir = process.env.PI_CODING_AGENT_DIR
  const previousWarn = console.warn
  const warnings = []
  process.env.PI_CODING_AGENT_DIR = root
  console.warn = message => warnings.push(message)
  try {
    const absent = await import('../extensions/artifacts/config.ts?absent')
    assert.equal(absent.CONFIG.theme, 'auto')
    assert.deepEqual(warnings, [])
    await mkdir(join(root, 'configs'))
    await writeFile(join(root, 'configs/artifacts.json'), 'not-json-private-value')
    const malformed = await import('../extensions/artifacts/config.ts?malformed')
    assert.deepEqual(malformed.CONFIG, absent.CONFIG)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /artifacts\.json; using defaults/)
    assert.doesNotMatch(warnings[0], /not-json-private-value/)
  } finally {
    console.warn = previousWarn
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousDir
    await rm(root, { recursive: true, force: true })
  }
})
