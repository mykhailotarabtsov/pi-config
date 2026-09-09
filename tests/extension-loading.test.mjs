import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { register } from 'node:module'
import test from 'node:test'

register('./ts-loader.mjs', import.meta.url)

// Use the real installed host exports: syntax checks alone cannot catch renamed
// Pi APIs or broken .js-to-.ts imports. Never execute tools or start sessions.
test('all auto-discovered local extension entrypoints import against installed Pi', async () => {
  const root = new URL('../extensions/', import.meta.url)
  let count = 0
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.name.endsWith('.ts')) continue
    const url = new URL(entry.isDirectory() ? `${entry.name}/index.ts` : entry.name, root)
    const extension = await import(url.href)
    assert.equal(typeof extension.default, 'function', url.pathname)
    count++
  }
  assert.ok(count >= 10)
})
