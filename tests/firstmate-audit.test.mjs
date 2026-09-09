import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { canMarkLeaseReturned, isWatcherPollHealthy, recordVerifiedEndpointAbsence, recordWatcherPollOutcome } from '../extensions/firstmate/lifecycle.ts'

class FakeHerdr {
  constructor() {
    this.tabs = []
    this.panes = []
  }

  listEndpoints() {
    return { tabs: this.tabs, panes: this.panes }
  }
}

class FakeTreehouse {
  constructor(evidence) {
    this.evidence = evidence
  }

  returnLease() {
    return this.evidence
  }
}

test('fake Herdr absence does not fake a Treehouse lease return', () => {
  const herdr = new FakeHerdr()
  const treehouse = new FakeTreehouse({ commandSucceeded: false, tempCleanupSucceeded: false, helperClosed: false })
  const task = {
    version: 1,
    taskId: 'task-a-12345678-123',
    project: '/repo',
    worktree: '/treehouse/repo',
    worktreeProvider: 'treehouse',
    leaseStatus: 'leased',
    leaseHolder: 'task-a-12345678-123',
    leaseId: 'lease-1',
    workspaceId: 'w1',
    tabId: 'w1:t2',
    paneId: 'w1:p2',
    branch: 'firstmate/task-a-12345678-123',
    status: 'started',
    reportPath: '/tmp/report.json',
    reportStatus: 'completed',
    createdAt: 'now',
    updatedAt: 'now',
  }

  const endpoints = herdr.listEndpoints()
  assert.equal(endpoints.tabs.length, 0)
  assert.equal(endpoints.panes.length, 0)
  const absentTask = recordVerifiedEndpointAbsence(task)
  assert.equal(absentTask.endpointStatus, 'absent_verified')
  assert.equal(absentTask.leaseStatus, 'leased')
  assert.equal(absentTask.leaseReturnStatus, undefined)
  assert.equal(canMarkLeaseReturned(treehouse.returnLease()), false)
})

test('fake Treehouse return evidence is required before lease becomes returned', () => {
  const task = {
    worktreeProvider: 'treehouse',
    leaseStatus: 'leased',
    endpointStatus: 'absent_verified',
  }
  const failed = new FakeTreehouse({ commandSucceeded: true, tempCleanupSucceeded: false, helperClosed: true }).returnLease()
  const successful = new FakeTreehouse({ commandSucceeded: true, tempCleanupSucceeded: true, helperClosed: true }).returnLease()
  assert.equal(canMarkLeaseReturned(failed), false)
  assert.equal(canMarkLeaseReturned(successful), true)
  assert.equal(recordVerifiedEndpointAbsence(task).leaseStatus, 'leased')
  const returnedTask = canMarkLeaseReturned(successful) ? { ...task, leaseStatus: 'returned', leaseReturnStatus: 'returned' } : task
  assert.equal(returnedTask.leaseStatus, 'returned')
  assert.equal(returnedTask.leaseReturnStatus, 'returned')
})

test('watcher health uses completed polls and rejects error, hang, and abort states', () => {
  const completedAt = '2025-01-01T00:00:00.000Z'
  const completed = recordWatcherPollOutcome({}, 'completed', completedAt)
  assert.equal(completed.lastCompletedPollAt, completedAt)
  assert.equal(isWatcherPollHealthy(completed.lastCompletedPollAt, Date.parse(completedAt) + 1000, 5000), true)

  const failed = recordWatcherPollOutcome(completed, 'error', '2025-01-01T00:00:01.000Z', 'fake Herdr error')
  assert.equal(failed.lastCompletedPollAt, completedAt)
  assert.equal(failed.lastError, 'fake Herdr error')
  assert.equal(isWatcherPollHealthy(failed.lastCompletedPollAt, Date.parse(completedAt) + 6000, 5000), false)

  const aborted = recordWatcherPollOutcome(completed, 'aborted', '2025-01-01T00:00:01.000Z')
  assert.equal(aborted.lastCompletedPollAt, completedAt)
  assert.match(aborted.lastError, /aborted/)
  // A hung poll has no completion transition, so its prior timestamp ages out.
  assert.equal(isWatcherPollHealthy(completed.lastCompletedPollAt, Date.parse(completedAt) + 6000, 5000), false)
})

test('Firstmate loads the canonical policy only from its active runtime path', async () => {
  const policy = await readFile(new URL('../extensions/firstmate/POLICY.md', import.meta.url), 'utf8')
  const source = await readFile(new URL('../extensions/firstmate/index.ts', import.meta.url), 'utf8')
  assert.match(policy, /The captain is its only user-facing contact/)
  assert.match(policy, /PI_PERMISSION_NO_PUBLISH=1/)
  assert.match(source, /const policyLoad = await readFirstmatePolicy\(\)/)
  assert.match(source, /firstmatePolicy = policyLoad\.policy/)
  assert.match(source, /return \{ systemPrompt: `\$\{firstmatePolicy\}/)
  assert.match(source, /throw new FirstmateControlError\(message, details\)/)
  assert.match(source, /pi\.on\('tool_result'/)
  assert.doesNotMatch(source, /FIRSTMATE_POLICY_(?:FALLBACK|EMERGENCY_FALLBACK)/)
  assert.doesNotMatch(source, /isError: true/)
})
