import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { register } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

register('./ts-loader.mjs', import.meta.url)

test('footer includes failed, aborted, delegated, and compaction costs and refreshes same-length branches', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-footer-accounting-'))
  const previousDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root
  const handlers = new Map()
  try {
    await mkdir(join(root, 'configs'))
    await writeFile(join(root, 'configs/footer.json'), JSON.stringify({
      row1LeftSegments: ['cost'], row1RightSegments: [], row2LeftSegments: [], row2RightSegments: [],
    }))
    const { default: footer } = await import('../extensions/footer/index.ts')
    footer({ on: (event, handler) => handlers.set(event, handler), getThinkingLevel: () => 'high' })
    const usage = cost => ({ input: 10, output: 20, cost: { total: cost } })
    const branch = [
      ...['stop', 'error', 'aborted'].map((stopReason, i) => ({
        id: String(i), type: 'message', message: { role: 'assistant', stopReason, usage: usage(i + 1) },
      })),
      { id: 'tool', type: 'message', message: { role: 'toolResult', usage: usage(4) } },
      { id: 'compact', type: 'compaction', usage: usage(5) },
    ]
    let component
    await handlers.get('session_start')({}, {
      mode: 'tui',
      sessionManager: { getBranch: () => branch },
      getContextUsage: () => undefined,
      ui: { setFooter: factory => {
        component = factory(
          { requestRender() {} },
          { fg: (_color, text) => text },
          { getGitBranch: () => null, onBranchChange: () => () => {} },
        )
      } },
    })
    assert.match(component.render(80).join('\n'), /\$15\.00/)
    branch[0].message.usage = usage(20)
    assert.match(component.render(80).join('\n'), /\$34\.00/)
  } finally {
    await handlers.get('session_shutdown')?.()
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousDir
    await rm(root, { recursive: true, force: true })
  }
})
