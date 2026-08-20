import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { collapseSegmentSeparators } from '../extensions/footer/segments/layout.ts'

test('collapses repeated separators across hidden optional segments', () => {
  const previousModes = new Map(
    ['__caveman', '__planMode', '__chatMode'].map((key) => [key, globalThis[key]]),
  )
  try {
    for (const key of previousModes.keys()) delete globalThis[key]

    const rendered = collapseSegmentSeparators([
      { id: 'text:left', content: 'left', width: 4, visible: true },
      { id: 'separator', content: '|', width: 1, visible: true },
      { id: 'caveman', content: '', width: 0, visible: false },
      { id: 'separator', content: '|', width: 1, visible: true },
      { id: 'plan_mode', content: '', width: 0, visible: false },
      { id: 'separator', content: '|', width: 1, visible: true },
      { id: 'chat_mode', content: '', width: 0, visible: false },
      { id: 'separator', content: '|', width: 1, visible: true },
      { id: 'text:right', content: 'right', width: 5, visible: true },
    ])

    assert.deepEqual(rendered.map(({ content }) => content), ['left', '|', 'right'])
  } finally {
    for (const [key, value] of previousModes) {
      if (value === undefined) delete globalThis[key]
      else globalThis[key] = value
    }
  }
})

test('default footer layout includes permissions', async () => {
  const source = await readFile(new URL('../extensions/footer/config.ts', import.meta.url), 'utf8')
  assert.match(source, /const DEFAULT_ROW2_LEFT: StatusLineSegmentId\[\] = \[[^\]]*permissions/)
})
