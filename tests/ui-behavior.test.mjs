import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'

register('./ts-loader.mjs', import.meta.url)

const { startBashSpinner, stopBashSpinner } = await import('../extensions/styled-outputs/bash-spinner.ts')
const {
  createPrototypePatchManager,
  hasLegacyPatchState,
  LEGACY_PATCH_STATE,
  LEGACY_PATCH_MESSAGE,
} = await import('../extensions/styled-outputs/patch-state.ts')
const { resolveContextUsage } = await import('../extensions/footer/context-usage.ts')
const { contextPctSegment } = await import('../extensions/footer/segments/context.ts')
const { costSegment } = await import('../extensions/footer/segments/cost.ts')
const { getCurrentBranch, invalidateGitBranch, onGitBranchChange } = await import('../extensions/footer/git-status.ts')

const theme = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
}

const context = (percent) => ({
  contextPercent: percent,
  contextWindow: 1000,
  options: {},
  theme,
  colors: {},
  usageStats: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 1.23 },
  isLocalModel: false,
})

test('bash spinner starts only while running and can be disposed', async () => {
  const execution = { status: 'running' }
  let frames = 0
  let renders = 0
  assert.equal(startBashSpinner(execution, ['a', 'b'], 5, () => frames++, () => renders++), true)
  assert.ok(execution._spinnerInterval)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.ok(frames > 0)
  assert.ok(renders > 0)

  stopBashSpinner(execution)
  const stoppedFrames = frames
  assert.equal(execution._spinnerInterval, undefined)
  await new Promise((resolve) => setTimeout(resolve, 15))
  assert.equal(frames, stoppedFrames)
})

test('completed bash execution before first render never starts a spinner', () => {
  const execution = { status: 'complete' }
  assert.equal(startBashSpinner(execution, ['a', 'b'], 5, () => {}, () => {}), false)
  assert.equal(execution._spinnerInterval, undefined)
})

test('prototype cleanup restores originals and a fresh manager can patch again', () => {
  const proto = { render() { return 'original' } }
  const first = createPrototypePatchManager({})
  first.patch(proto, 'render', function firstRender() { return 'first' })
  assert.equal(proto.render(), 'first')

  // A live reload replaces the old manager rather than wrapping its wrapper.
  const reloaded = createPrototypePatchManager({})
  reloaded.patch(proto, 'render', function reloadedRender() { return 'reloaded' })
  assert.equal(proto.render(), 'reloaded')
  reloaded.cleanup()
  assert.equal(proto.render(), 'original')

  const second = createPrototypePatchManager({})
  second.patch(proto, 'render', function secondRender() { return 'second' })
  assert.equal(proto.render(), 'second')
  second.cleanup()
  assert.equal(proto.render(), 'original')
})

test('legacy styled-output state is detected instead of being layered', () => {
  const proto = {}
  Object.defineProperty(proto, LEGACY_PATCH_STATE, { value: true })
  assert.equal(hasLegacyPatchState([proto]), true)
  assert.match(LEGACY_PATCH_MESSAGE, /restart Pi/i)
})

test('footer keeps unknown context usage unknown and still renders cost', () => {
  assert.deepEqual(resolveContextUsage({ percent: null, contextWindow: 1000 }, 2000), {
    percent: null,
    contextWindow: 1000,
  })
  const rendered = contextPctSegment.render(context(null))
  assert.match(rendered.content, /\?%/)
  assert.doesNotMatch(rendered.content, /0\.0%/)

  const cost = costSegment.render(context(null))
  assert.match(cost.content, /\$1\.23/)
})

test('footer can refresh after asynchronous git branch completion', async () => {
  invalidateGitBranch()
  let refreshes = 0
  const remove = onGitBranchChange(() => refreshes++)
  try {
    getCurrentBranch('fallback')
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.ok(refreshes >= 1)
  } finally {
    remove()
  }
})
