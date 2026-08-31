import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { EndpointAbsenceStatus } from './lifecycle.ts'

export const TASK_STATE_DIR = path.join(os.homedir(), '.pi', 'firstmate', 'tasks')
export const TASK_VERSION = 1

export type WorkerKind = 'pi' | 'claude'
export type WorktreeProvider = 'herdr' | 'treehouse'
export type LeaseStatus = 'pending' | 'leased' | 'retained' | 'returned'
export type TaskStatus = 'provisioning' | 'worktree_created' | 'worktree_leased' | 'starting' | 'started' | 'failed'
export type ReportOutcome = 'completed' | 'blocked' | 'failed'
export type ReportStatus = 'pending' | 'completed' | 'blocked' | 'failed' | 'missing' | 'malformed'
export type CleanupStatus = 'pending' | 'closing' | 'tab_closed'
export type DeliveryStatus = 'landing' | 'landed' | 'failed'

export type WorkerReport = {
  version: number
  taskId: string
  outcome: ReportOutcome
  changedFiles: string[]
  tests: Array<string | Record<string, unknown>>
  validation: string[]
  blockers: string[]
  summary: string
}

export type TaskRecord = {
  version: number
  taskId: string
  project: string
  worktree: string | null
  worktreeProvider?: WorktreeProvider
  leaseStatus?: LeaseStatus
  leaseHolder?: string
  leaseId?: string
  leaseReturnStatus?: 'returned' | 'failed'
  leaseReturnAt?: string
  leaseReturnCode?: number | null
  leaseReturnStdout?: string
  leaseReturnStderr?: string
  leaseReturnError?: string
  deliveryStatus?: DeliveryStatus
  deliveryTargetBranch?: string
  deliveryDefaultBranch?: string
  deliveryBeforeCommit?: string
  deliveryCommit?: string
  deliveryAt?: string
  deliveryCode?: number | null
  deliveryStdout?: string
  deliveryStderr?: string
  deliveryError?: string
  deliveryHelperTabId?: string
  deliveryHelperPaneId?: string
  leaseReturnHelperTabId?: string
  leaseReturnHelperPaneId?: string
  workspaceId: string | null
  tabId: string | null
  paneId: string | null
  branch: string
  reviewTarget?: string
  workerName?: string
  workerKind?: WorkerKind
  status: TaskStatus
  reportPath: string
  reportStatus: ReportStatus
  reportOutcome?: ReportOutcome
  reportUpdatedAt?: string
  reportSummary?: string
  reportError?: string
  cleanupStatus?: CleanupStatus
  cleanupUpdatedAt?: string
  cleanupError?: string
  endpointStatus?: EndpointAbsenceStatus
  createdAt: string
  updatedAt: string
  error?: string
}

export function taskFilePath(taskId: string): string {
  return path.join(TASK_STATE_DIR, `${taskId}.json`)
}

export function reportFilePath(taskId: string): string {
  return path.join(TASK_STATE_DIR, `${taskId}.report.json`)
}

export async function readTaskState(taskId: string): Promise<TaskRecord | undefined> {
  try {
    return JSON.parse(await fs.promises.readFile(taskFilePath(taskId), 'utf8')) as TaskRecord
  } catch {
    return undefined
  }
}

export async function writeTaskState(record: TaskRecord): Promise<string> {
  await fs.promises.mkdir(TASK_STATE_DIR, { recursive: true, mode: 0o700 })
  const destination = taskFilePath(record.taskId)
  const temporary = path.join(TASK_STATE_DIR, `.${record.taskId}.${process.pid}.${randomUUID()}.tmp`)
  try {
    await fs.promises.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await fs.promises.rename(temporary, destination)
  } finally {
    await fs.promises.unlink(temporary).catch(() => undefined)
  }
  return destination
}

export function newTaskId(): string {
  return `task-${Date.now().toString(36)}-${randomUUID().slice(0, 12)}`
}
