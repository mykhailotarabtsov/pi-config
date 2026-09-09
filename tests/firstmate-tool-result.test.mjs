import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeFirstmateToolResult } from '../extensions/firstmate/tool-result.ts'

test('native Firstmate tool errors preserve one captured per-call detail payload', () => {
  const pending = new Map([['call-1', { action: 'task_reconcile', taskId: 'task-a' }]])
  const event = { toolName: 'herdr_control', toolCallId: 'call-1', isError: true }
  assert.deepEqual(normalizeFirstmateToolResult(event, pending), { details: { action: 'task_reconcile', taskId: 'task-a' } })
  assert.equal(pending.has('call-1'), false)
  assert.equal(normalizeFirstmateToolResult(event, pending), undefined)
})
