import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../extensions/', import.meta.url)
const read = (name) => readFile(new URL(name, root), 'utf8')

test('chat input companion timer is demand-driven and disposable', async () => {
  const source = await read('chat-input/index.ts')
  const constructor = source.slice(source.indexOf('constructor('), source.indexOf('private startCompanionTimer'))
  assert.doesNotMatch(constructor, /setInterval\(/)
  assert.match(source, /startCompanionTimer\(\)/)
  assert.match(source, /stopCompanionTimer\(\)/)
  assert.match(source, /dispose\(\): void/)
  assert.match(source, /pi\.on\("session_shutdown"/)
})

test('spinners keep refresh and cycling timers alive across streamed text blocks', async () => {
  const source = await read('spinners/index.ts')
  const textStartBranch = source.slice(source.indexOf('evt.type === "text_start"'), source.indexOf('} else if (evt.type === "text"'))
  assert.match(textStartBranch, /stopTypeTimer\(\)/)
  assert.doesNotMatch(textStartBranch, /stopAllTimers\(\)/)
  assert.match(source, /pi\.on\("session_shutdown"[\s\S]*?resetState\(\)/)
})

test('footer uses live usage/thinking APIs and owns global render hook cleanup', async () => {
  const source = await read('footer/index.ts')
  assert.match(source, /ctx\.getContextUsage\(\)/)
  assert.match(source, /thinkingLevel: ctx\.thinkingLevel/)
  assert.match(source, /delete globals\.__footerRequestRender/)
  assert.match(source, /cachedUsageStats = null/)
  assert.match(source, /event\.toolName === "write" \|\| event\.toolName === "edit"[\s\S]*?requestRender\(\)/)
})

test('styled output patches have explicit restore state and reload-safe user bash listener', async () => {
  const source = await read('styled-outputs/index.ts')
  const patchState = await read('styled-outputs/patch-state.ts')
  assert.match(patchState, /Object\.getOwnPropertyDescriptor\(proto, key\)/)
  assert.match(patchState, /Object\.defineProperty\(record\.proto, record\.key, record\.original\)/)
  assert.match(patchState, /delete proto\[PATCH_STATE\]/)
  assert.match(patchState, /LEGACY_PATCH_STATE = Symbol\.for\("styled-outputs:patched"\)/)
  assert.match(source, /pi\.on\("user_bash"/)
  assert.match(source, /activeBashExecutions\.clear\(\)/)
})

test('startup dashboard uses runtime command provenance instead of loader replication', async () => {
  const discovery = await read('startup/discovery.ts')
  const layout = await read('startup/layout.ts')
  assert.match(discovery, /extensionCommands: commands\.filter/)
  assert.match(discovery, /runtime: Pick<LoadedCounts/)
  assert.doesNotMatch(discovery.slice(discovery.indexOf('export function discoverLoadedCounts')), /countExtensions\(/)
  assert.match(layout, /extension command/)
  assert.doesNotMatch(layout, /MCP config/)
})

test('config loaders use Pi agent directory resolution', async () => {
  for (const example of ['artifacts/artifacts.example.json', 'styled-outputs/styled-outputs.example.json']) {
    const source = await readFile(new URL(`../extensions/${example}`, import.meta.url), 'utf8')
    assert.doesNotThrow(() => JSON.parse(source), example)
  }
  for (const name of [
    'artifacts/config.ts',
    'chat-input/config.ts',
    'footer/config.ts',
    'spinners/config.ts',
    'styled-outputs/config.ts',
  ]) {
    const source = await read(name)
    assert.match(source, /getAgentDir\(\)/, name)
    assert.doesNotMatch(source, /join\(homedir\(\)/, name)
  }
})
