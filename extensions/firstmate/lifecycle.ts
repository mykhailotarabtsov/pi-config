import type { TaskRecord } from './task-state.ts'

export const WAIT_STATUSES = ['idle', 'done', 'blocked', 'working', 'unknown'] as const

const ALLOWED_FIRSTMATE_SUBAGENT = 'browser-tester'

export function isAllowedFirstmateSubagentRequest(input: unknown): boolean {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return false
  const request = input as Record<string, unknown>
  if (request.agentScope !== undefined && request.agentScope !== 'user') return false
  const requestedAgents: unknown[] = []
  let modeCount = 0
  if (request.agent !== undefined || request.task !== undefined) {
    if (typeof request.agent !== 'string' || typeof request.task !== 'string' || !request.task.trim()) return false
    requestedAgents.push(request.agent)
    modeCount++
  }
  for (const mode of ['tasks', 'chain']) {
    if (request[mode] === undefined) continue
    if (!Array.isArray(request[mode]) || request[mode].length === 0) return false
    modeCount++
    for (const entry of request[mode]) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return false
      const task = entry as Record<string, unknown>
      if (typeof task.agent !== 'string' || typeof task.task !== 'string' || !task.task.trim()) return false
      requestedAgents.push(task.agent)
    }
  }
  return modeCount === 1 && requestedAgents.every((agent) => agent === ALLOWED_FIRSTMATE_SUBAGENT)
}

export class LifecycleOperationLock {
  private tail = Promise.resolve()

  async acquire(): Promise<() => void> {
    const previous = this.tail
    let release!: () => void
    this.tail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    let released = false
    return () => {
      if (released) return
      released = true
      release()
    }
  }
}

export type WaitStatus = (typeof WAIT_STATUSES)[number]

/** Accept the current array form and the legacy scalar form. */
export function normalizeUntil(value: WaitStatus | WaitStatus[] | undefined): WaitStatus[] {
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

export function appendUntilArgs(args: string[], value: WaitStatus | WaitStatus[] | undefined): string[] {
  for (const status of normalizeUntil(value)) args.push('--until', status)
  return args
}

export function canMarkLeaseReturned(input: { commandSucceeded: boolean; tempCleanupSucceeded: boolean; helperClosed: boolean }): boolean {
  return input.commandSucceeded && input.tempCleanupSucceeded && input.helperClosed
}

/** Record endpoint absence without claiming that an external lease was returned. */
export function recordVerifiedEndpointAbsence(task: TaskRecord): TaskRecord {
  const next = { ...task, endpointStatus: 'absent_verified' as const }
  if (task.worktreeProvider === 'treehouse' && task.leaseStatus === 'leased') {
    next.leaseStatus = 'leased'
    if (task.leaseReturnStatus === 'returned') next.leaseReturnStatus = 'failed'
  }
  return next
}

export type WatcherPollOutcome = 'completed' | 'error' | 'aborted'
export type WatcherPollState = { lastCompletedPollAt?: string; lastError?: string }

/** Update watcher health only after a poll actually completes. */
export function recordWatcherPollOutcome(
  state: WatcherPollState,
  outcome: WatcherPollOutcome,
  completedAt: string,
  error?: string,
): WatcherPollState {
  if (outcome === 'completed') return { lastCompletedPollAt: completedAt }
  return { lastCompletedPollAt: state.lastCompletedPollAt, lastError: error || (outcome === 'aborted' ? 'watcher poll aborted' : 'watcher poll failed') }
}

export function isWatcherPollHealthy(lastCompletedPollAt: string | undefined, now: number, recencyWindowMs: number): boolean {
  if (!lastCompletedPollAt) return false
  const completedAt = Date.parse(lastCompletedPollAt)
  if (!Number.isFinite(completedAt)) return false
  const age = now - completedAt
  return age >= 0 && age <= recencyWindowMs
}

export function isPendingLeaseNoop(status: string | undefined): boolean {
  return status === 'pending'
}

export type EndpointAbsenceStatus = 'recorded' | 'absent_verified' | 'unverified'

export function canDeleteWithoutRecordedEndpoint(status: string | undefined): boolean {
  return status === 'absent_verified'
}

export function hasExactWorkerIdentity(
  recorded: { workspaceId: string; tabId: string; paneId: string; workerName: string; workerKind: string },
  observed: Record<string, unknown> | undefined,
): boolean {
  return Boolean(
    observed &&
      observed.workspace_id === recorded.workspaceId &&
      observed.tab_id === recorded.tabId &&
      observed.pane_id === recorded.paneId &&
      observed.name === recorded.workerName &&
      observed.agent === recorded.workerKind,
  )
}

export function endpointListsConfirmAbsence(input: {
  tabListSucceeded: boolean
  paneListSucceeded: boolean
  tabs: unknown
  panes: unknown
  tabId: string
  paneId: string
}): boolean {
  if (!input.tabListSucceeded || !input.paneListSucceeded || !Array.isArray(input.tabs) || !Array.isArray(input.panes)) return false
  return (
    !input.tabs.some((entry) => typeof entry === 'object' && entry !== null && !Array.isArray(entry) && (entry as Record<string, unknown>).tab_id === input.tabId) &&
    !input.panes.some((entry) => typeof entry === 'object' && entry !== null && !Array.isArray(entry) && (entry as Record<string, unknown>).pane_id === input.paneId)
  )
}

/** Exact, bounded names written by one firstmate task. Never replace with a glob. */
export function taskArtifactNames(taskId: string): string[] {
  return [
    `${taskId}.report.json`,
    `.${taskId}.lease.json`,
    `.${taskId}.lease.stderr`,
    `.${taskId}.lease.status`,
    `.${taskId}.lease-return.stdout`,
    `.${taskId}.lease-return.stderr`,
    `.${taskId}.lease-return.status`,
    `.${taskId}.delivery.evidence`,
    `.${taskId}.delivery.dirty-paths`,
    `.${taskId}.delivery.worker-paths`,
    `.${taskId}.delivery.stdout`,
    `.${taskId}.delivery.stderr`,
    `.${taskId}.delivery.status`,
    `.${taskId}.delivery.sh`,
  ]
}

export function taskArtifactPaths(taskId: string, stateDir: string): string[] {
  return taskArtifactNames(taskId).map((name) => `${stateDir}/${name}`)
}