import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'

register('./ts-loader.mjs', import.meta.url)
register('./host-loader.mjs', import.meta.url)

const { BoundedJsonlReader, RollingMessageBuffer, getLatestAssistantText, messageUsesTools } = await import('../extensions/subagent/stream.ts')
const { canRetryWithFallback, getFinalOutput } = await import('../extensions/subagent/index.ts')

function readRows(chunks, maxLineBytes = 128 * 1024) {
  const lines = []
  const overflows = []
  const reader = new BoundedJsonlReader({
    maxLineBytes,
    onLine: (line) => lines.push(JSON.parse(line)),
    onOverflow: (overflow) => overflows.push(overflow),
  })
  for (const chunk of chunks) reader.push(chunk)
  reader.end()
  return { lines, overflows }
}

test('bounded JSONL reader processes more than 2000 events', () => {
  const input = Array.from({ length: 2501 }, (_, index) => JSON.stringify({ index }) + '\n')
  const { lines, overflows } = readRows([Buffer.from(input.join(''))])
  assert.equal(lines.length, 2501)
  assert.equal(lines.at(-1).index, 2500)
  assert.equal(overflows.length, 0)
})

test('oversized row is dropped through its newline and later same-chunk rows survive', () => {
  const final = JSON.stringify({ final: true })
  const { lines, overflows } = readRows([Buffer.from(`${'x'.repeat(40)}\n${final}\n`)], 16)
  assert.deepEqual(lines, [{ final: true }])
  assert.equal(overflows.length, 1)
  assert.equal(overflows[0].maxBytes, 16)
})

test('bounded JSONL reader preserves UTF-8 split across chunks', () => {
  const encoded = Buffer.from(JSON.stringify({ text: '€ café' }) + '\n')
  const chunks = Array.from(encoded, (byte) => Buffer.from([byte]))
  const { lines, overflows } = readRows(chunks)
  assert.deepEqual(lines, [{ text: '€ café' }])
  assert.equal(overflows.length, 0)
})

test('rolling message retention keeps the newest assistant summary', () => {
  const buffer = new RollingMessageBuffer(400, 2 * 1024 * 1024)
  for (let index = 0; index < 400; index++) buffer.append({ role: 'assistant', content: [{ type: 'text', text: String(index) }] }, 1)
  const final = { role: 'assistant', content: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }] }
  buffer.append(final, 1)
  assert.equal(buffer.items.length, 400)
  assert.equal(buffer.items[0].content[0].text, '1')
  assert.equal(getLatestAssistantText(buffer.items), 'firstsecond')
  assert.equal(getFinalOutput(buffer.items), 'firstsecond')
})

test('tool usage remains monotonic after the tool message is evicted', () => {
  const buffer = new RollingMessageBuffer(400, 2 * 1024 * 1024)
  const toolCall = { role: 'assistant', content: [{ type: 'toolCall', name: 'read', arguments: {} }] }
  let usedTools = messageUsesTools(toolCall)
  buffer.append(toolCall, 1)
  for (let index = 0; index < 400; index++) {
    const message = { role: 'assistant', content: [{ type: 'text', text: String(index) }] }
    usedTools ||= messageUsesTools(message)
    buffer.append(message, 1)
  }
  assert.equal(buffer.items.some(messageUsesTools), false)
  assert.equal(usedTools, true)
  assert.equal(canRetryWithFallback({ exitCode: 1, messages: buffer.items, usedTools, usage: {}, stderr: '' }), false)
})
