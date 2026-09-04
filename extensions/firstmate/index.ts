import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Text } from '@earendil-works/pi-tui'
import { assessLocalDelivery, canCleanupAfterDelivery } from './delivery.ts'
import { FIRSTMATE_ALLOWED_TOOLS, FIRSTMATE_CONTROL_ACTIONS, isFirstmateAllowedTool, isFirstmateControlAction, type FirstmateControlAction } from './control.ts'
import {
  canDeleteWithoutRecordedEndpoint,
  canMarkLeaseReturned,
  endpointListsConfirmAbsence,
  hasExactWorkerIdentity,
  isPendingLeaseNoop,
  isAllowedFirstmateSubagentRequest,
  LifecycleOperationLock,
  taskArtifactPaths,
  type EndpointAbsenceStatus,
} from './lifecycle.ts'
import {
  newTaskId,
  readTaskState,
  reportFilePath,
  TASK_STATE_DIR,
  taskFilePath,
  TASK_VERSION,
  writeTaskState,
  type TaskRecord,
  type WorkerKind,
  type WorkerReport,
} from './task-state.ts'
import { validateWorkerReport, workerReportContract } from './worker-report.ts'
import { StringEnum } from '@earendil-works/pi-ai'
import { Type } from 'typebox'

const MARKER_DIR = path.join(os.tmpdir(), 'pi-herdr-firstmate')
const MARKER_VERSION = 1
const SHARED_ADMISSION_LOCK_PREFIX = '.shared-admission-'
const FIRSTMATE_WORKER_BIN_DIR = path.join(os.homedir(), '.pi', 'agent', 'extensions', 'firstmate', 'worker-git')
const WORKER_ENV = 'PI_FIRSTMATE_WORKER'
const TASK_ENV = 'PI_FIRSTMATE_TASK_ID'
const REPORT_ENV = 'PI_FIRSTMATE_REPORT_PATH'
const ACTIVE_ENV = 'PI_FIRSTMATE_ACTIVE'
const FIRSTMATE_NAME = 'firstmate'
const AGENT_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/
const PANE_ID_RE = /^w[0-9A-Za-z]+:p[0-9A-Za-z]+$/
const TAB_ID_RE = /^w[0-9A-Za-z]+:t[0-9A-Za-z]+$/
const WORKSPACE_ID_RE = /^w[0-9A-Za-z]+$/
const AGENT_KIND_RE = /^[a-z][a-z0-9_-]{0,31}$/
const ALLOWED_WORKER_KINDS = ['pi', 'claude'] as const
const DEFAULT_WORKER_KIND = 'pi' as const
const TASK_ID_RE = /^task-[a-z0-9]+-[0-9a-f]{8}-[0-9a-f]{3}$/
const WATCHER_INTERVAL_MS = 5_000
const WATCHER_RECENCY_WINDOW_MS = 2 * WATCHER_INTERVAL_MS
const TREEHOUSE_RETURN_SUCCESS_MARKER = 'Worktree returned to pool.'
const PI_WORKER_NATIVE_ARGS = ['--model', 'openai-codex/gpt-5.6-luna', '--thinking', 'high']
const ISOLATION_STATE_ENTRY = 'firstmate-isolation'
const WORKER_STATE_ENTRY = 'firstmate-worker'
const LIFECYCLE_ACTIONS = new Set<FirstmateControlAction>(['task_create', 'task_reconcile', 'task_abort', 'task_recover', 'task_deliver', 'task_teardown'])

const FIRSTMATE_SYSTEM_PROMPT = `
# Herdr Firstmate Runtime Role

You are the Herdr firstmate for this workspace. The captain is your only user-facing contact; coordinate software work and do not implement it. AGENTS.md is the canonical stable Firstmate policy; follow it even if prompt ordering changes.

## Runtime safety delta

- This pane is coordination-only: use read, grep, find, and ls for read-only inspection, use the browser-tester subagent only for browser QA, and use herdr_control.task_create / visible worker tabs for all implementation and code mutations; never call mcp directly. The artifact tool is the sole generated-output exception. Use artifact only for generated browser artifacts, reports, or diagrams under the project \`.pi/artifacts/\` directory; that output is not implementation work and does not permit arbitrary file edits. Never use local bash, edit, or write; delegate mutations through worker panes.
- Preserve unrelated changes and keep worker changes surgical. Workers must never push, publish, or commit unless the captain explicitly authorizes a local commit; the worker-git guard still applies. The browser-tester subagent is the sole MCP-capable delegate and may use MCP only for browser QA; it must never automate sign-in or handle credentials.
- Decide the number of workers yourself; do not ask the captain to choose it. One visible worker is the default; use two only for genuinely independent, bounded scopes, never uncontrolled fan-out. Delegate broad codebase reconnaissance and read-heavy investigation instead of spending a long local read/grep loop here. Narrow one-file questions may be inspected directly.
- \`task_create\` is asynchronous/no-wait: create the worker, keep this pane focused on the captain, and rely on watcher follow-ups rather than polling or waiting on the worker.
- Inspect enough context before delegation, ask focused clarification for ambiguity, create one visible tab per worker without taking focus, and reconcile the structured worker report before claiming completion.
- Shared tasks stay in the requested checkout and never use task_deliver. Worktree tasks use Treehouse leases, require task_deliver before task_teardown, and are never auto-closed or auto-merged. Herdr has no native agent stop command; task_abort/task_recover use explicit pane close only with force and verify endpoint absence before lease recovery.
- Keep the captain's focus here and report only verified outcomes, files, tests, validation, reconciliation evidence, and blockers. Failed/blocked shared reports may close only an exact idle/done worker tab after absence verification; never force-close an active/hung worker. Treehouse leases and worker changes are never auto-returned or discarded.

## Captain-facing output discipline

- Do not narrate internal inspection, commands, tool arguments, endpoint checks, or durable paths.
- Use the \`subagent\` tool only with \`agent: "browser-tester"\` for browser QA; never use it for implementation or reconnaissance. Firstmate itself must never call \`mcp\`.
- After \`task_create\`, give only a concise confirmation that the worker started and is working.
- Do not poll or read worker scrollback for routine progress; watcher notifications and the structured report are the source of truth.
- After \`task_reconcile\`, show only the worker report: summary, changed files, tests, validation, and blockers. Keep errors and blockers concise.
`.trim()

const HerdrControlParams = Type.Object({
  action: StringEnum(FIRSTMATE_CONTROL_ACTIONS),
  project: Type.Optional(Type.String({ description: 'Requested primary project checkout for task_create or task_deliver. Resolved relative to the firstmate cwd.' })),
  taskId: Type.Optional(Type.String({ description: 'Durable firstmate task id for task reconciliation, delivery, cleanup, or recovery.' })),
  label: Type.Optional(Type.String({ description: 'Optional label for a visible worker tab.' })),
  kind: Type.Optional(StringEnum(ALLOWED_WORKER_KINDS, { description: 'Allowlisted worker kind for task_create: pi (default) or claude.' })),
  prompt: Type.Optional(Type.String({ description: 'Precise worker brief for task_create.' })),
  timeoutMs: Type.Optional(Type.Number({ description: 'Timeout in milliseconds for a high-level task operation.' })),
  force: Type.Optional(Type.Boolean({ description: 'For task_abort/task_recover, explicitly stop an active worker with pane close.' })),
  discard: Type.Optional(Type.Boolean({ description: 'For task_abort/task_recover, explicitly allow returning a leased worktree with --force.' })),
  reviewTarget: Type.Optional(Type.String({ description: 'Optional existing local or remote-tracking ref to inspect for a review task; implementation tasks omit it.' })),
})

type ExecResult = { stdout: string; stderr: string; code: number | null; killed?: boolean }
type ControlParams = {
  action: FirstmateControlAction | 'tab_close'
  project?: string
  taskId?: string
  // Internal only: task_teardown passes the exact recorded tab into the private close path.
  tabId?: string
  label?: string
  kind?: WorkerKind
  prompt?: string
  timeoutMs?: number
  force?: boolean
  discard?: boolean
  reviewTarget?: string
}

type Marker = {
  version: number
  workspaceId: string
  paneId: string
  pid: number
  createdAt: string
}

type IsolationMode = 'shared' | 'worktree'

type NativeWorkerState = 'working' | 'blocked' | 'idle' | 'done'
type WatcherObservation = { state?: NativeWorkerState; edgeLatched: boolean; endpointMissingLatched: boolean }
type WatcherMissingEndpoint = { taskId: string; workspaceId: string | null; tabId: string | null; paneId: string | null; workerName?: string; workerKind?: string }

function isWatcherTaskRecord(value: unknown, taskId: string): value is TaskRecord {
  if (!isRecord(value) || value.version !== TASK_VERSION || value.taskId !== taskId || !TASK_ID_RE.test(taskId)) return false
  if (
    value.status !== 'provisioning' &&
    value.status !== 'worktree_created' &&
    value.status !== 'worktree_leased' &&
    value.status !== 'starting' &&
    value.status !== 'started' &&
    value.status !== 'failed'
  )
    return false
  if (
    value.reportStatus !== 'pending' &&
    value.reportStatus !== 'completed' &&
    value.reportStatus !== 'blocked' &&
    value.reportStatus !== 'failed' &&
    value.reportStatus !== 'missing' &&
    value.reportStatus !== 'malformed'
  )
    return false
  if (value.cleanupStatus !== undefined && value.cleanupStatus !== 'pending' && value.cleanupStatus !== 'closing' && value.cleanupStatus !== 'tab_closed') return false
  if (value.endpointStatus !== undefined && value.endpointStatus !== 'recorded' && value.endpointStatus !== 'absent_verified' && value.endpointStatus !== 'unverified') return false
  if (value.worktreeProvider !== undefined && value.worktreeProvider !== 'herdr' && value.worktreeProvider !== 'treehouse') return false
  if (value.leaseStatus !== undefined && value.leaseStatus !== 'pending' && value.leaseStatus !== 'leased' && value.leaseStatus !== 'retained' && value.leaseStatus !== 'returned') return false
  if (value.leaseReturnStatus !== undefined && value.leaseReturnStatus !== 'returned' && value.leaseReturnStatus !== 'failed') return false
  if (value.leaseReturnAt !== undefined && typeof value.leaseReturnAt !== 'string') return false
  if (value.leaseReturnCode !== undefined && value.leaseReturnCode !== null && typeof value.leaseReturnCode !== 'number') return false
  if (value.leaseReturnStdout !== undefined && typeof value.leaseReturnStdout !== 'string') return false
  if (value.leaseReturnStderr !== undefined && typeof value.leaseReturnStderr !== 'string') return false
  if (value.leaseReturnError !== undefined && typeof value.leaseReturnError !== 'string') return false
  if (value.deliveryStatus !== undefined && value.deliveryStatus !== 'landing' && value.deliveryStatus !== 'landed' && value.deliveryStatus !== 'failed') return false
  if (value.deliveryTargetBranch !== undefined && typeof value.deliveryTargetBranch !== 'string') return false
  if (value.deliveryDefaultBranch !== undefined && typeof value.deliveryDefaultBranch !== 'string') return false
  if (value.deliveryBeforeCommit !== undefined && typeof value.deliveryBeforeCommit !== 'string') return false
  if (value.deliveryCommit !== undefined && typeof value.deliveryCommit !== 'string') return false
  if (value.deliveryAt !== undefined && typeof value.deliveryAt !== 'string') return false
  if (value.deliveryCode !== undefined && value.deliveryCode !== null && typeof value.deliveryCode !== 'number') return false
  if (value.deliveryStdout !== undefined && typeof value.deliveryStdout !== 'string') return false
  if (value.deliveryStderr !== undefined && typeof value.deliveryStderr !== 'string') return false
  if (value.deliveryError !== undefined && typeof value.deliveryError !== 'string') return false
  if (value.deliveryHelperTabId !== undefined && typeof value.deliveryHelperTabId !== 'string') return false
  if (value.deliveryHelperPaneId !== undefined && typeof value.deliveryHelperPaneId !== 'string') return false
  if (value.reviewTarget !== undefined && typeof value.reviewTarget !== 'string') return false
  if (value.workerKind !== undefined && !isWorkerKind(value.workerKind)) return false
  if (value.leaseReturnHelperTabId !== undefined && typeof value.leaseReturnHelperTabId !== 'string') return false
  if (value.leaseReturnHelperPaneId !== undefined && typeof value.leaseReturnHelperPaneId !== 'string') return false
  return true
}

function hasWatcherEndpoint(task: TaskRecord, workspaceId: string): boolean {
  return (
    task.status !== 'failed' &&
    task.cleanupStatus !== 'tab_closed' &&
    typeof task.workspaceId === 'string' &&
    WORKSPACE_ID_RE.test(task.workspaceId) &&
    task.workspaceId === workspaceId &&
    typeof task.tabId === 'string' &&
    TAB_ID_RE.test(task.tabId) &&
    typeof task.paneId === 'string' &&
    PANE_ID_RE.test(task.paneId) &&
    typeof task.workerName === 'string' &&
    AGENT_NAME_RE.test(task.workerName) &&
    task.workerName !== FIRSTMATE_NAME &&
    typeof task.workerKind === 'string' &&
    AGENT_KIND_RE.test(task.workerKind)
  )
}

function validateTaskId(value: string | undefined): string | undefined {
  if (!value) return '`taskId` is required.'
  if (!TASK_ID_RE.test(value)) return '`taskId` must be a generated firstmate task id.'
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isIsolationMode(value: unknown): value is IsolationMode {
  return value === 'shared' || value === 'worktree'
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

async function acquireSharedAdmissionLock(project: string): Promise<{ release: () => Promise<void>; path: string }> {
  await fs.promises.mkdir(TASK_STATE_DIR, { recursive: true, mode: 0o700 })
  const lockPath = path.join(TASK_STATE_DIR, `${SHARED_ADMISSION_LOCK_PREFIX}${safeHash(project)}.lock`)
  const ownerPath = path.join(lockPath, 'owner.json')
  const token = randomUUID()
  const record = { version: 1, token, pid: process.pid, project, createdAt: new Date().toISOString() }
  for (;;) {
    try {
      await fs.promises.mkdir(lockPath, 0o700)
      try {
        await fs.promises.writeFile(ownerPath, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      } catch (error) {
        await fs.promises.rm(lockPath, { recursive: true, force: true }).catch(() => undefined)
        throw error
      }
      return {
        path: lockPath,
        release: async () => {
          try {
            const current = JSON.parse(await fs.promises.readFile(ownerPath, 'utf8')) as { token?: unknown }
            if (current.token !== token) return
            await fs.promises.unlink(ownerPath).catch((error) => {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            })
            await fs.promises.rmdir(lockPath).catch((error) => {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error
            })
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
        },
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      let existing: { pid?: unknown } | undefined
      try {
        existing = JSON.parse(await fs.promises.readFile(ownerPath, 'utf8')) as { pid?: unknown }
      } catch {
        throw new Error('shared-checkout admission is locked by an unreadable durable lock; preserve it for manual inspection.')
      }
      if (typeof existing.pid !== 'number' || !Number.isInteger(existing.pid) || existing.pid <= 0) {
        throw new Error('shared-checkout admission is locked by an invalid durable lock; preserve it for manual inspection.')
      }
      try {
        process.kill(existing.pid, 0)
        throw new Error('shared-checkout admission is already locked by another Firstmate process.')
      } catch (probeError) {
        if ((probeError as NodeJS.ErrnoException).code !== 'ESRCH') throw probeError
        const stalePath = `${lockPath}.stale-${randomUUID()}`
        try {
          await fs.promises.rename(lockPath, stalePath)
        } catch (renameError) {
          if ((renameError as NodeJS.ErrnoException).code === 'ENOENT') continue
          throw renameError
        }
        await fs.promises.rm(stalePath, { recursive: true, force: true })
      }
    }
  }
}

function treehouseWorkerBranchCommand(branch: string, reviewTarget?: string): string {
  return (
    [
      '#!/bin/sh',
      `branch=${shellQuote(branch)}`,
      `review_target=${shellQuote(reviewTarget || '')}`,
      'if [ -n "$review_target" ]; then',
      '  base="$review_target"',
      'else',
      '  origin_head=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || true)',
      '  if [ -n "$origin_head" ]; then',
      '    base="$origin_head"',
      '  else',
      '    base=',
      '    for candidate in main master; do',
      '      if git show-ref --verify --quiet "refs/heads/$candidate"; then base="refs/heads/$candidate"; break; fi',
      '      if git show-ref --verify --quiet "refs/remotes/origin/$candidate"; then base="refs/remotes/origin/$candidate"; break; fi',
      '    done',
      '  fi',
      'fi',
      'if [ -z "$base" ] || ! git rev-parse --verify --quiet "$base^{commit}" >/dev/null 2>&1; then',
      '  echo "could not resolve the worker base ref: ${base:-none}" >&2',
      '  exit 1',
      'fi',
      'git switch --create "$branch" -- "$base"',
      'current=$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)',
      'if [ "$current" != "$branch" ]; then echo "worker branch checkout did not land on $branch" >&2; exit 1; fi',
    ].join('\n') + '\n'
  )
}

function inHerdr(): boolean {
  return process.env.HERDR_ENV === '1' && !!process.env.HERDR_WORKSPACE_ID && !!process.env.HERDR_PANE_ID
}

function firstmateGitPath(): string {
  const candidates = (process.env.PATH || '').split(path.delimiter).filter((entry) => entry && entry !== FIRSTMATE_WORKER_BIN_DIR)
  for (const entry of candidates) {
    const candidate = path.join(entry, 'git')
    try {
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {
      // Continue searching the inherited PATH.
    }
  }
  return '/usr/bin/git'
}

function workerPath(): string {
  const nvmNodeSegment = `${path.sep}.nvm${path.sep}versions${path.sep}node${path.sep}`
  const inheritedPath = (process.env.PATH || '').split(path.delimiter).filter((entry) => entry && !entry.includes(nvmNodeSegment) && entry !== FIRSTMATE_WORKER_BIN_DIR)
  return [FIRSTMATE_WORKER_BIN_DIR, path.dirname(process.execPath), ...inheritedPath].join(path.delimiter)
}

function isInteractivePiPane(ctx: { hasUI?: boolean }): boolean {
  return Boolean(ctx.hasUI && process.stdin.isTTY && process.stdout.isTTY)
}

function safeHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 32)
}

function socketIdentity(): string {
  const socketPath = process.env.HERDR_SOCKET_PATH || 'unknown-socket'
  try {
    const stat = fs.statSync(socketPath)
    return `${socketPath}:${stat.dev}:${stat.ino}:${stat.ctimeMs}`
  } catch {
    return socketPath
  }
}

function markerPath(): string {
  const workspaceId = process.env.HERDR_WORKSPACE_ID || 'unknown-workspace'
  return path.join(MARKER_DIR, `${safeHash(`${socketIdentity()}:${workspaceId}`)}.json`)
}

async function readMarker(filePath: string): Promise<Marker | undefined> {
  try {
    return JSON.parse(await fs.promises.readFile(filePath, 'utf8')) as Marker
  } catch {
    return undefined
  }
}

async function acquireFirstmateMarker(isPaneLive: (paneId: string) => Promise<boolean>): Promise<boolean> {
  const workspaceId = process.env.HERDR_WORKSPACE_ID
  const paneId = process.env.HERDR_PANE_ID
  if (!workspaceId || !paneId) return false
  if (process.env[WORKER_ENV] === '1') return false

  await fs.promises.mkdir(MARKER_DIR, { recursive: true, mode: 0o700 })
  const filePath = markerPath()
  const existing = await readMarker(filePath)
  if (existing?.paneId === paneId && existing.workspaceId === workspaceId) return true
  if (existing) {
    if (await isPaneLive(existing.paneId)) return false
    await fs.promises.unlink(filePath).catch(() => undefined)
  }

  const marker: Marker = {
    version: MARKER_VERSION,
    workspaceId,
    paneId,
    pid: process.pid,
    createdAt: new Date().toISOString(),
  }

  try {
    const handle = await fs.promises.open(filePath, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(marker, null, 2)}\n`, 'utf8')
    } finally {
      await handle.close()
    }
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
}

function validatePaneId(value: string | undefined, field = 'paneId'): string | undefined {
  if (!value) return `\`${field}\` is required.`
  if (!PANE_ID_RE.test(value)) return `\`${field}\` must be a Herdr pane id like w1:p2.`
  return undefined
}

function validateTabId(value: string | undefined): string | undefined {
  if (!value) return '`tabId` is required.'
  if (!TAB_ID_RE.test(value)) return '`tabId` must be an opaque Herdr tab id like w1:t2.'
  return undefined
}

function isWorkerKind(value: unknown): value is WorkerKind {
  return ALLOWED_WORKER_KINDS.includes(value as WorkerKind)
}

function validateWorkerKind(value: string | undefined): string | undefined {
  if (!value) return 'worker kind is required; use `pi` or `claude`.'
  if (!isWorkerKind(value)) return '`kind` must be one of: pi, claude.'
  return undefined
}

function validateOptionalCwd(value: string | undefined): string | undefined {
  if (value && value.includes('\u0000')) return '`cwd` must not contain NUL bytes.'
  return undefined
}

function validateTimeout(value: number | undefined): string | undefined {
  if (value === undefined) return undefined
  if (!Number.isFinite(value) || value < 1 || value > 24 * 60 * 60 * 1000) return '`timeoutMs` must be between 1 and 86400000.'
  return undefined
}

function errorResult(message: string, details: Record<string, unknown> = {}) {
  return {
    content: [{ type: 'text' as const, text: `Error: ${message}` }],
    isError: true,
    details,
  }
}

function parseJsonMaybe(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

function commandResultText(label: string, result: ExecResult): string {
  const parts = [`${label} exited ${result.code ?? 'unknown'}${result.killed ? ' (killed)' : ''}.`]
  if (result.stdout.trim()) parts.push(`stdout:\n${result.stdout.trimEnd()}`)
  if (result.stderr.trim()) parts.push(`stderr:\n${result.stderr.trimEnd()}`)
  return parts.join('\n\n')
}

function isRetryableAgentStartFailure(result: ExecResult): boolean {
  const output = `${result.stdout}\n${result.stderr}`
  return result.code !== 0 && /agent_pane_busy/.test(output) && /not an available shell/i.test(output)
}

function isCurrentFirstmateOccupyingRecordedEndpoint(
  recorded: { workspaceId: string; tabId: string; paneId: string; workerName: string; workerKind: string },
  observed: Record<string, unknown> | undefined,
  currentPaneId: string | undefined,
): boolean {
  return Boolean(
    currentPaneId &&
      PANE_ID_RE.test(currentPaneId) &&
      observed &&
      observed.workspace_id === recorded.workspaceId &&
      observed.tab_id === recorded.tabId &&
      observed.pane_id === recorded.paneId &&
      observed.pane_id === currentPaneId &&
      observed.name === FIRSTMATE_NAME &&
      !hasExactWorkerIdentity(recorded, observed),
  )
}

function appendWorkerNativeArgs(args: string[], kind: string, nativeArgs: string[] = []): void {
  if (nativeArgs.length || kind === 'pi') args.push('--', ...nativeArgs)
  if (kind === 'pi') args.push(...PI_WORKER_NATIVE_ARGS)
}

const FIRSTMATE_RENDER_MAX_CHARS = 2_000
const FIRSTMATE_RENDER_MAX_LINES = 12

function boundedFirstmateRenderText(value: unknown): string {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value))
  const lines = text.trim().split(/\r?\n/)
  let bounded = lines.slice(0, FIRSTMATE_RENDER_MAX_LINES).join('\n')
  if (lines.length > FIRSTMATE_RENDER_MAX_LINES) bounded += '\n... more output'
  if (bounded.length > FIRSTMATE_RENDER_MAX_CHARS) bounded = `${bounded.slice(0, FIRSTMATE_RENDER_MAX_CHARS - 3)}...`
  return bounded
}

const FIRSTMATE_ACTION_LABELS: Record<string, string> = {
  task_create: 'worker started · working',
  task_reconcile: 'worker report',
  task_deliver: 'worker changes delivered',
  task_teardown: 'worker cleanup complete',
  task_abort: 'worker recovery complete',
  task_recover: 'worker recovery complete',
}

function firstmateActionLabel(action: string): string {
  return FIRSTMATE_ACTION_LABELS[action] || action.replaceAll('_', ' ')
}

function workerReportRenderText(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.summary !== 'string') return undefined
  const outcome = typeof value.outcome === 'string' ? ` (${value.outcome})` : ''
  const lines = [`report${outcome}: ${value.summary}`]
  const sections: Array<[string, string]> = [
    ['changedFiles', 'changed files'],
    ['tests', 'tests'],
    ['validation', 'validation'],
    ['blockers', 'blockers'],
  ]
  for (const [key, label] of sections) {
    const entries = value[key]
    if (!Array.isArray(entries) || entries.length === 0) continue
    lines.push(`${label}:`)
    for (const entry of entries) lines.push(`- ${typeof entry === 'string' ? entry : (JSON.stringify(entry) ?? String(entry))}`)
  }
  return boundedFirstmateRenderText(lines.join('\n'))
}

export default function firstmate(pi: ExtensionAPI) {
  if (!inHerdr()) return

  delete process.env[ACTIVE_ENV]
  let active = false
  let registered = false
  let isolationCommandRegistered = false
  let workerCommandRegistered = false
  let isolationMode: IsolationMode = 'shared'
  let selectedWorkerKind: WorkerKind = DEFAULT_WORKER_KIND
  let currentAgentKind: string | undefined
  let watcherInterval: ReturnType<typeof setInterval> | undefined
  let watcherRunning = false
  let watcherPollInFlight = false
  let watcherLastPollAt: string | undefined
  let watcherLastError: string | undefined
  let watcherGuardStatus = 'not_checked'
  let watcherGuardDiagnostic: string | undefined
  let turnEndGuardLatched = false
  let turnEndGuardPending = false
  let turnEndGuardFollowUpStarted = false
  let turnEndGuardCheckInFlight = false
  let turnEndGuardRegistered = false
  let restoreToolsExpanded: (() => void) | undefined
  const lifecycleLock = new LifecycleOperationLock()
  const watcherObservations = new Map<string, WatcherObservation>()
  const watcherMissingEndpoints = new Map<string, WatcherMissingEndpoint>()

  async function runHerdr(args: string[], signal: AbortSignal | undefined, timeout = 30_000): Promise<ExecResult> {
    return await pi.exec('herdr', args, { signal, timeout })
  }

  async function deriveCurrentAgentKind(signal?: AbortSignal): Promise<string | undefined> {
    if (currentAgentKind) return currentAgentKind
    const paneId = process.env.HERDR_PANE_ID
    if (!paneId || !PANE_ID_RE.test(paneId)) return undefined
    const result = await runHerdr(['agent', 'get', paneId], signal, 5_000)
    if (result.code !== 0) return undefined
    const parsed = parseJsonMaybe(result.stdout) as { result?: { agent?: { agent?: unknown } } } | undefined
    const kind = parsed?.result?.agent?.agent
    if (typeof kind === 'string' && AGENT_KIND_RE.test(kind)) {
      currentAgentKind = kind
      return kind
    }
    return undefined
  }

  async function renameHerdrAgent(signal?: AbortSignal): Promise<void> {
    const paneId = process.env.HERDR_PANE_ID
    if (!paneId || !PANE_ID_RE.test(paneId)) return
    await runHerdr(['agent', 'rename', paneId, FIRSTMATE_NAME], signal, 5_000).catch(() => undefined)
  }

  function watcherDetails(): Record<string, unknown> {
    return {
      active: watcherRunning,
      isolationMode,
      intervalMs: WATCHER_INTERVAL_MS,
      lastPollAt: watcherLastPollAt,
      health: watcherLastError ? 'degraded' : 'ok',
      error: watcherLastError,
      unverifiedWorkers: [...watcherMissingEndpoints.values()],
      turnEndGuard: {
        status: watcherGuardStatus,
        diagnostic: watcherGuardDiagnostic,
        latched: turnEndGuardLatched,
        pending: turnEndGuardPending,
      },
    }
  }

  function durableTaskSummary(tasks: TaskRecord[]): Record<string, unknown> {
    const records = tasks.map((task) => ({
      taskId: task.taskId,
      project: task.project,
      status: task.status,
      reportStatus: task.reportStatus,
      reportOutcome: task.reportOutcome,
      cleanupStatus: task.cleanupStatus,
      endpointStatus: task.endpointStatus,
      worktreeProvider: task.worktreeProvider,
      workspaceId: task.workspaceId,
      tabId: task.tabId,
      paneId: task.paneId,
      workerName: task.workerName,
      workerKind: task.workerKind,
      visibility: watcherMissingEndpoints.has(task.taskId) ? 'missing' : task.cleanupStatus === 'tab_closed' ? 'closed' : 'recorded',
    }))
    const active = records.filter(
      (record) =>
        record.status !== 'failed' &&
        record.cleanupStatus !== 'tab_closed' &&
        record.reportStatus !== 'completed' &&
        record.reportStatus !== 'blocked' &&
        record.reportStatus !== 'failed',
    )
    const stale = records.filter(
      (record) =>
        record.status === 'failed' ||
        record.cleanupStatus === 'pending' ||
        record.cleanupStatus === 'closing' ||
        ((record.reportStatus === 'failed' || record.reportStatus === 'blocked') && record.cleanupStatus !== 'tab_closed') ||
        (record.reportStatus === 'completed' && record.cleanupStatus !== 'tab_closed'),
    )
    const missing = records.filter((record) => record.visibility === 'missing')
    return { total: records.length, active, stale, missing, records }
  }

  async function readWatcherTaskRecords(onReadError?: (error: unknown, filePath: string) => void): Promise<TaskRecord[]> {
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(TASK_STATE_DIR, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const tasks: TaskRecord[] = []
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name.endsWith('.report.json')) continue
      const taskId = entry.name.slice(0, -'.json'.length)
      if (!TASK_ID_RE.test(taskId)) continue
      const filePath = path.join(TASK_STATE_DIR, entry.name)
      try {
        const parsed = JSON.parse(await fs.promises.readFile(filePath, 'utf8')) as unknown
        if (isWatcherTaskRecord(parsed, taskId)) {
          tasks.push(parsed)
        } else {
          onReadError?.(new Error('task-state record is malformed'), filePath)
        }
      } catch (error) {
        onReadError?.(error, filePath)
      }
    }
    return tasks
  }

  async function readActiveWatcherTaskState(): Promise<{ active: boolean; diagnostic?: string }> {
    const workspaceId = process.env.HERDR_WORKSPACE_ID
    if (!workspaceId || !WORKSPACE_ID_RE.test(workspaceId)) {
      return { active: false, diagnostic: 'current Herdr workspace identity is missing or invalid' }
    }
    try {
      let readDiagnostic: string | undefined
      const tasks = await readWatcherTaskRecords((error, filePath) => {
        readDiagnostic ||= `task-state read failed for ${filePath}: ${(error as Error).message}`
      })
      if (readDiagnostic) return { active: false, diagnostic: readDiagnostic }
      const active = tasks.some(
        (task) => task.status === 'started' && task.cleanupStatus !== 'tab_closed' && hasWatcherEndpoint(task, workspaceId) && task.reportStatus !== 'completed' && task.reportStatus !== 'failed',
      )
      return { active }
    } catch (error) {
      return { active: false, diagnostic: `task-state read failed: ${(error as Error).message}` }
    }
  }

  function watcherSupervision(): { healthy: boolean; diagnostic?: string } {
    if (!watcherRunning) return { healthy: false, diagnostic: 'watcher is not running' }
    if (watcherLastError) return { healthy: false, diagnostic: `watcher error: ${watcherLastError}` }
    if (!watcherLastPollAt) return { healthy: false, diagnostic: 'watcher has not completed a poll' }
    const lastPollAt = Date.parse(watcherLastPollAt)
    if (!Number.isFinite(lastPollAt)) return { healthy: false, diagnostic: 'watcher lastPollAt is invalid' }
    const age = Date.now() - lastPollAt
    if (age < 0 || age > WATCHER_RECENCY_WINDOW_MS) {
      return { healthy: false, diagnostic: `watcher last poll is ${age}ms old; expected at most ${WATCHER_RECENCY_WINDOW_MS}ms` }
    }
    return { healthy: true }
  }

  async function superviseTurnEnd(): Promise<void> {
    const taskState = await readActiveWatcherTaskState()
    if (taskState.diagnostic) {
      watcherGuardStatus = 'task_state_read_failed'
      watcherGuardDiagnostic = taskState.diagnostic
      return
    }
    if (!taskState.active) {
      watcherGuardStatus = 'no_active_work'
      watcherGuardDiagnostic = undefined
      return
    }
    if (turnEndGuardLatched) {
      watcherGuardStatus = 'follow_up_latched'
      watcherGuardDiagnostic = 'turn-end follow-up already sent for this firstmate run'
      return
    }

    const supervision = watcherSupervision()
    if (supervision.healthy) {
      watcherGuardStatus = 'supervision_healthy'
      watcherGuardDiagnostic = undefined
      return
    }

    turnEndGuardLatched = true
    turnEndGuardPending = true
    try {
      pi.sendUserMessage(
        `FIRSTMATE TURN-END GUARD: Active durable worker work remains, but watcher supervision is not healthy/recent (${supervision.diagnostic || 'unknown supervision problem'}). Restore and reconcile watcher supervision before continuing; do not assume worker completion.`,
        { deliverAs: 'followUp' },
      )
      watcherGuardStatus = 'follow_up_sent'
      watcherGuardDiagnostic = supervision.diagnostic
    } catch (error) {
      turnEndGuardPending = false
      watcherGuardStatus = 'follow_up_send_failed'
      watcherGuardDiagnostic = `follow-up failed: ${(error as Error).message}`
    }
  }

  function watcherState(value: unknown): NativeWorkerState | undefined {
    return value === 'working' || value === 'blocked' || value === 'idle' || value === 'done' ? value : undefined
  }

  function watcherTaskCandidate(task: TaskRecord, workspaceId: string): boolean {
    return task.status === 'started' && task.cleanupStatus !== 'tab_closed' && task.workspaceId === workspaceId && task.reportStatus !== 'completed' && task.reportStatus !== 'failed'
  }

  function notifyMissingEndpoint(task: TaskRecord): void {
    const previous = watcherObservations.get(task.taskId)
    const missing: WatcherMissingEndpoint = {
      taskId: task.taskId,
      workspaceId: task.workspaceId,
      tabId: task.tabId,
      paneId: task.paneId,
      workerName: task.workerName,
      workerKind: task.workerKind,
    }
    watcherMissingEndpoints.set(task.taskId, missing)
    let endpointMissingLatched = previous?.endpointMissingLatched ?? false
    if (!endpointMissingLatched) {
      const identity = `tab=${task.tabId ?? 'missing'}, pane=${task.paneId ?? 'missing'}, worker=${task.workerName ?? 'missing'}${task.workerKind ? ` (${task.workerKind})` : ''}`
      endpointMissingLatched =
        notifyWatcher(
          `FIRSTMATE WATCHER: Task ${task.taskId} worker endpoint cannot be verified (${identity}). Do not classify it as idle/done or completed; inspect the durable task and recover/reconcile the recorded endpoint.`,
        ) || endpointMissingLatched
    }
    watcherObservations.set(task.taskId, { state: previous?.state, edgeLatched: false, endpointMissingLatched })
  }

  function notifyWatcher(message: string): boolean {
    if (!watcherRunning) return false
    try {
      pi.sendUserMessage(message, { deliverAs: 'steer' })
      return true
    } catch (error) {
      watcherLastError = `notification failed: ${(error as Error).message}`
      return false
    }
  }

  async function pollWatcher(): Promise<void> {
    if (!watcherRunning || watcherPollInFlight) return
    watcherPollInFlight = true
    watcherLastPollAt = new Date().toISOString()
    const seenTaskIds = new Set<string>()
    let sweepObservations = false
    try {
      const workspaceId = process.env.HERDR_WORKSPACE_ID
      if (!workspaceId || !WORKSPACE_ID_RE.test(workspaceId)) {
        watcherLastError = 'current Herdr workspace identity is missing or invalid'
        return
      }
      let readDiagnostic: string | undefined
      const tasks = await readWatcherTaskRecords((error, filePath) => {
        readDiagnostic ||= `task-state read failed for ${filePath}: ${(error as Error).message}`
      })
      if (readDiagnostic) {
        watcherLastError = readDiagnostic
        return
      }
      watcherLastError = undefined
      sweepObservations = true
      for (const task of tasks) {
        if (!watcherRunning) return
        if (!watcherTaskCandidate(task, workspaceId)) continue
        seenTaskIds.add(task.taskId)
        if (!hasWatcherEndpoint(task, workspaceId)) {
          notifyMissingEndpoint(task)
          continue
        }

        const result = await runHerdr(['agent', 'get', task.paneId!], undefined, 5_000).catch(() => undefined)
        const parsed = result && result.code === 0 ? (parseJsonMaybe(result.stdout) as { result?: { agent?: Record<string, unknown> } } | undefined) : undefined
        const agent = parsed?.result?.agent
        if (
          !watcherRunning ||
          !result ||
          result.code !== 0 ||
          !agent ||
          agent.pane_id !== task.paneId ||
          agent.tab_id !== task.tabId ||
          agent.workspace_id !== task.workspaceId ||
          agent.name !== task.workerName ||
          agent.agent !== task.workerKind
        ) {
          notifyMissingEndpoint(task)
          continue
        }

        watcherMissingEndpoints.delete(task.taskId)
        const state = watcherState(agent.agent_status)
        if (!state) {
          notifyMissingEndpoint(task)
          continue
        }
        const previous = watcherObservations.get(task.taskId)
        if (state === 'working') {
          watcherObservations.set(task.taskId, { state, edgeLatched: false, endpointMissingLatched: false })
          continue
        }
        if (state === 'idle') {
          try {
            await fs.promises.access(task.reportPath, fs.constants.R_OK)
          } catch {
            watcherObservations.set(task.taskId, { state: 'working', edgeLatched: false, endpointMissingLatched: false })
            continue
          }
        }

        let edgeLatched = previous?.edgeLatched ?? false
        const actionable = task.reportStatus !== 'completed' && (state === 'blocked' || state === 'idle' || state === 'done')
        if (actionable && previous?.state !== state && !edgeLatched) {
          const detail =
            state === 'blocked'
              ? `FIRSTMATE WATCHER: Task ${task.taskId} worker ${task.workerName} entered blocked. Firstmate, inspect worker ${task.workerName} and handle the approval/blocker.`
              : `FIRSTMATE WATCHER: Task ${task.taskId} worker ${task.workerName} entered ${state} with reportStatus=${task.reportStatus}. Firstmate, run task_reconcile for ${task.taskId} and inspect the worker result.`
          edgeLatched = notifyWatcher(detail) || edgeLatched
        }
        watcherObservations.set(task.taskId, { state, edgeLatched, endpointMissingLatched: false })
      }
    } catch (error) {
      watcherLastError = `poll failed: ${(error as Error).message}`
    } finally {
      if (sweepObservations) {
        for (const taskId of watcherObservations.keys()) {
          if (!seenTaskIds.has(taskId)) watcherObservations.delete(taskId)
        }
        for (const taskId of watcherMissingEndpoints.keys()) {
          if (!seenTaskIds.has(taskId)) watcherMissingEndpoints.delete(taskId)
        }
      }
      watcherPollInFlight = false
    }
  }

  function startWatcher(): void {
    if (watcherRunning || watcherInterval) return
    watcherRunning = true
    watcherInterval = setInterval(() => void pollWatcher(), WATCHER_INTERVAL_MS)
    watcherInterval.unref?.()
    void pollWatcher()
  }

  function stopWatcher(): void {
    watcherRunning = false
    if (watcherInterval) clearInterval(watcherInterval)
    watcherInterval = undefined
    watcherPollInFlight = false
    watcherObservations.clear()
    watcherMissingEndpoints.clear()
  }

  function registerTurnEndGuard(): void {
    if (turnEndGuardRegistered) return
    turnEndGuardRegistered = true
    pi.on('agent_start', () => {
      if (!active) return
      turnEndGuardLatched = false
      if (turnEndGuardPending) turnEndGuardFollowUpStarted = true
    })
    pi.on('agent_settled', async (_event, ctx) => {
      if (!active || ctx?.isIdle?.() !== true) return
      if (turnEndGuardFollowUpStarted || turnEndGuardPending) {
        turnEndGuardFollowUpStarted = false
        turnEndGuardPending = false
        turnEndGuardLatched = false
        watcherGuardStatus = 'follow_up_settled'
        watcherGuardDiagnostic = undefined
        return
      }
      if (turnEndGuardCheckInFlight) return
      turnEndGuardCheckInFlight = true
      try {
        await superviseTurnEnd()
      } finally {
        turnEndGuardCheckInFlight = false
      }
    })
  }

  function applyFirstmateTools(): void {
    const available = new Set(pi.getAllTools().map((tool) => tool.name))
    pi.setActiveTools(FIRSTMATE_ALLOWED_TOOLS.filter((name) => available.has(name)))
  }

  function restoreIsolationMode(ctx: { sessionManager: { getBranch: () => Array<{ type: string; customType?: string; data?: unknown }> } }): void {
    isolationMode = 'shared'
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== 'custom' || entry.customType !== ISOLATION_STATE_ENTRY || !isRecord(entry.data) || !isIsolationMode(entry.data.mode)) continue
      isolationMode = entry.data.mode
    }
  }

  function registerIsolationCommand(): void {
    if (isolationCommandRegistered) return
    isolationCommandRegistered = true
    pi.registerCommand('firstmate-isolation', {
      description: 'Show or set worker isolation for this session: shared (default) or worktree.',
      handler: async (args, ctx) => {
        if (!active) {
          ctx.ui.notify('Firstmate isolation is only available in the active Herdr firstmate pane.', 'warning')
          return
        }
        const requested = args.trim()
        if (!requested) {
          ctx.ui.notify(`Firstmate isolation: ${isolationMode}. Use /firstmate-isolation shared or /firstmate-isolation worktree.`, 'info')
          return
        }
        if (!isIsolationMode(requested)) {
          ctx.ui.notify('Use /firstmate-isolation shared or /firstmate-isolation worktree.', 'warning')
          return
        }
        try {
          pi.appendEntry(ISOLATION_STATE_ENTRY, { mode: requested })
          isolationMode = requested
          ctx.ui.notify(`Firstmate isolation set to ${isolationMode} for this session.`, 'info')
        } catch (error) {
          ctx.ui.notify(`Could not persist Firstmate isolation: ${(error as Error).message}`, 'error')
        }
      },
    })
  }

  function restoreWorkerKind(ctx: { sessionManager: { getBranch: () => Array<{ type: string; customType?: string; data?: unknown }> } }): void {
    selectedWorkerKind = DEFAULT_WORKER_KIND
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== 'custom' || entry.customType !== WORKER_STATE_ENTRY || !isRecord(entry.data) || !isWorkerKind(entry.data.kind)) continue
      selectedWorkerKind = entry.data.kind
    }
  }

  function registerWorkerCommand(): void {
    if (workerCommandRegistered) return
    workerCommandRegistered = true
    pi.registerCommand('firstmate-worker', {
      description: 'Show or set the worker kind for this session: pi (default) or claude.',
      handler: async (args, ctx) => {
        if (!active) {
          ctx.ui.notify('Firstmate worker selection is only available in the active Herdr firstmate pane.', 'warning')
          return
        }
        const requested = args.trim()
        if (!requested) {
          ctx.ui.notify(`Firstmate worker: ${selectedWorkerKind}. Use /firstmate-worker pi or /firstmate-worker claude.`, 'info')
          return
        }
        if (!isWorkerKind(requested)) {
          ctx.ui.notify('Use /firstmate-worker pi or /firstmate-worker claude.', 'warning')
          return
        }
        try {
          pi.appendEntry(WORKER_STATE_ENTRY, { kind: requested })
          selectedWorkerKind = requested
          ctx.ui.notify(`Firstmate worker set to ${selectedWorkerKind} for this session.`, 'info')
        } catch (error) {
          ctx.ui.notify(`Could not persist Firstmate worker selection: ${(error as Error).message}`, 'error')
        }
      },
    })
  }

  function registerFirstmateTool(): void {
    if (registered) return
    registered = true

    pi.registerTool({
      name: 'herdr_control',
      label: 'Herdr Control',
      description:
        'Coordinate this Herdr workspace through high-level task creation, report reconciliation, delivery, cleanup, and recovery. Worker tabs, panes, and agents are internal implementation details. Use the browser-tester subagent only for browser QA; all implementation and code mutations must use herdr_control.task_create and visible worker tabs. Firstmate itself never calls MCP. Herdr has no native agent stop command; forced recovery uses pane close and verifies absence.',
      promptSnippet: 'Delegate visible workers, reconcile their reports, then safely deliver, clean up, or recover their tasks',
      promptGuidelines: [
        'Use herdr_control.task_create and visible worker tabs for all implementation and code mutations; use the subagent tool only with agent: "browser-tester" for browser QA, never for implementation or reconnaissance. Firstmate must never call mcp. Use artifact only for generated browser artifacts, reports, or diagrams under the project \\`.pi/artifacts/\\` directory, not implementation work or arbitrary file edits. Never use bash, edit, or write. Delegate mutations through worker panes.',
        'Use the subagent tool only with agent: "browser-tester" for browser QA. That delegate may use MCP for browser interaction, but sign-in must always be performed manually by the captain; never automate credentials or authentication. Do not use subagent for implementation or reconnaissance.',
        'Choose the worker count yourself; do not ask the captain to choose it. Use one visible implementation worker by default; use two only for genuinely independent, bounded scopes; never fan out uncontrollably. Delegate broad codebase reconnaissance and read-heavy investigation instead of doing long local read/grep loops. Inspect narrow one-file questions directly when that is simpler.',
        'task_create is asynchronous/no-wait: create the worker, keep the firstmate focused on the captain, and rely on watcher follow-ups rather than polling or waiting for worker completion.',
        'Use task_create with the current session isolation mode, one visible tab per implementation worker, and the selected worker kind. Reconcile the structured report before claiming completion; shared tasks never use task_deliver, while worktree tasks require task_deliver before task_teardown.',
        'Implementation workers and their subagents must not push, publish, or commit without explicit captain authorization. The browser-tester delegate may use MCP only for browser QA and must report when manual sign-in is required. Failed/blocked shared reports may use only the guarded exact idle/done tab cleanup; never force-close active/hung workers. Never auto-return or discard Treehouse leases; report only verified outcomes and preserve unrelated changes.',
      ],
      parameters: HerdrControlParams,
      renderCall(_args, theme, context) {
        const action = typeof context.args.action === 'string' ? context.args.action : 'unknown'
        const label = firstmateActionLabel(action)
        if (context.isPartial) return new Text(theme.fg('warning', `⏳ ${label}`), 0, 0)
        const status = context.isError ? theme.fg('error', `✗ ${label}`) : theme.fg('success', `✓ ${label}`)
        return new Text(status, 0, 0)
      },
      renderResult(result, { isPartial }, theme, context) {
        if (isPartial) return new Text('', 0, 0)
        const action = typeof context.args.action === 'string' ? context.args.action : 'unknown'
        if (action !== 'task_reconcile') return new Text('', 0, 0)
        const report = isRecord(result.details) ? workerReportRenderText(result.details.report) : undefined
        if (report) return new Text(report, 0, 0)
        const resultText = boundedFirstmateRenderText(result.content.map((entry) => (entry.type === 'text' ? entry.text : `[${entry.type}]`)).join('\n'))
        return new Text(theme.fg(context.isError ? 'error' : 'muted', resultText), 0, 0)
      },
      async execute(_toolCallId, params: ControlParams, signal, _onUpdate, ctx) {
        if (!active) return errorResult('herdr_control is only available in the active Herdr firstmate pane.')
        if (!inHerdr()) return errorResult('not running inside Herdr.')
        if (!isFirstmateControlAction(params.action)) return errorResult('unsupported Firstmate task operation.', { action: params.action })

        const releaseLifecycle = isFirstmateControlAction(params.action) && LIFECYCLE_ACTIONS.has(params.action) ? await lifecycleLock.acquire() : undefined
        let releaseSharedAdmission: (() => Promise<void>) | undefined
        try {
          const timeoutError = validateTimeout(params.timeoutMs)
          if (timeoutError) return errorResult(timeoutError, { action: params.action })
          const timeout = params.timeoutMs ?? 120_000
          const readPaneFile = async (filePath: string): Promise<string> => {
            const deadline = Date.now() + timeout
            while (Date.now() < deadline) {
              try {
                return await fs.promises.readFile(filePath, 'utf8')
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
              }
              await new Promise((resolve) => setTimeout(resolve, 100))
            }
            throw new Error(`timed out waiting for ${filePath}`)
          }
          type RawHelper = { tabId: string; paneId: string; workspaceId: string }
          const closeRawHelper = async (helper: RawHelper): Promise<{ closed: boolean; absent?: boolean; error?: string; result?: ExecResult }> => {
            const [tabListResult, paneListResult] = await Promise.all([
              runHerdr(['tab', 'list', '--workspace', helper.workspaceId], signal, 10_000),
              runHerdr(['pane', 'list', '--workspace', helper.workspaceId], signal, 10_000),
            ])
            const tabs = (parseJsonMaybe(tabListResult.stdout) as { result?: { tabs?: unknown } } | undefined)?.result?.tabs
            const panes = (parseJsonMaybe(paneListResult.stdout) as { result?: { panes?: unknown } } | undefined)?.result?.panes
            if (endpointListsConfirmAbsence({ tabListSucceeded: tabListResult.code === 0, paneListSucceeded: paneListResult.code === 0, tabs, panes, tabId: helper.tabId, paneId: helper.paneId })) {
              return { closed: true, absent: true, result: tabListResult }
            }
            const currentPaneId = process.env.HERDR_PANE_ID
            if (!currentPaneId || !PANE_ID_RE.test(currentPaneId)) return { closed: false, error: 'current firstmate pane id is invalid; preserving helper tab.' }
            const currentResult = await runHerdr(['pane', 'get', currentPaneId], signal, 10_000)
            const current = (parseJsonMaybe(currentResult.stdout) as { result?: { pane?: Record<string, unknown> } } | undefined)?.result?.pane
            const tabResult = await runHerdr(['tab', 'get', helper.tabId], signal, 10_000)
            const tab = (parseJsonMaybe(tabResult.stdout) as { result?: { tab?: Record<string, unknown> } } | undefined)?.result?.tab
            const panesResult = await runHerdr(['pane', 'list', '--workspace', helper.workspaceId], signal, 10_000)
            const listedPanes = (parseJsonMaybe(panesResult.stdout) as { result?: { panes?: Array<Record<string, unknown>> } } | undefined)?.result?.panes
            const matchingPanes = listedPanes?.filter((pane) => pane.tab_id === helper.tabId) ?? []
            const pane = matchingPanes.length === 1 ? matchingPanes[0] : undefined
            const agentResult = pane && typeof pane.pane_id === 'string' ? await runHerdr(['agent', 'get', pane.pane_id], signal, 10_000) : { stdout: '', stderr: '', code: 1 }
            const agent = (parseJsonMaybe(agentResult.stdout) as { result?: { agent?: Record<string, unknown> } } | undefined)?.result?.agent
            if (currentResult.code !== 0 || !current || current.pane_id !== currentPaneId || current.workspace_id !== helper.workspaceId || current.tab_id === helper.tabId)
              return { closed: false, error: 'refusing to close helper tab because it is the current firstmate tab.' }
            if (
              tabResult.code !== 0 ||
              !tab ||
              tab.tab_id !== helper.tabId ||
              tab.workspace_id !== helper.workspaceId ||
              tab.pane_count !== 1 ||
              panesResult.code !== 0 ||
              matchingPanes.length !== 1 ||
              !pane ||
              pane.pane_id !== helper.paneId ||
              pane.workspace_id !== helper.workspaceId ||
              pane.tab_id !== helper.tabId ||
              (agentResult.code === 0 && agent)
            )
              return { closed: false, error: 'helper tab identity is no longer exact or has an agent; preserving helper tab.' }
            const result = await runHerdr(['tab', 'close', helper.tabId], signal, 10_000)
            if (result.code !== 0) return { closed: false, error: commandResultText('herdr tab close (helper)', result), result }
            const [verifyTabs, verifyPanes] = await Promise.all([
              runHerdr(['tab', 'list', '--workspace', helper.workspaceId], signal, 10_000),
              runHerdr(['pane', 'list', '--workspace', helper.workspaceId], signal, 10_000),
            ])
            const verifiedTabs = (parseJsonMaybe(verifyTabs.stdout) as { result?: { tabs?: unknown } } | undefined)?.result?.tabs
            const verifiedPanes = (parseJsonMaybe(verifyPanes.stdout) as { result?: { panes?: unknown } } | undefined)?.result?.panes
            const verifiedAbsent = endpointListsConfirmAbsence({
              tabListSucceeded: verifyTabs.code === 0,
              paneListSucceeded: verifyPanes.code === 0,
              tabs: verifiedTabs,
              panes: verifiedPanes,
              tabId: helper.tabId,
              paneId: helper.paneId,
            })
            return { closed: verifiedAbsent, error: verifiedAbsent ? undefined : 'helper tab close was not verified absent; preserving helper identity.', result }
          }
          const createRawHelper = async (workspaceId: string, cwd: string, label: string): Promise<{ helper?: RawHelper; error?: string; result?: Record<string, unknown> }> => {
            const tabArgs = ['tab', 'create', '--workspace', workspaceId, '--cwd', cwd, '--label', label, '--no-focus']
            const tabResult = await runHerdr(tabArgs, signal, 10_000)
            const payload = parseJsonMaybe(tabResult.stdout) as { result?: { tab?: Record<string, unknown>; root_pane?: Record<string, unknown> } } | undefined
            const returnedTab = payload?.result?.tab
            const returnedPane = payload?.result?.root_pane
            const tabId = returnedTab?.tab_id
            const paneId = returnedPane?.pane_id
            const helper = typeof tabId === 'string' && TAB_ID_RE.test(tabId) && typeof paneId === 'string' && PANE_ID_RE.test(paneId) ? { tabId, paneId, workspaceId } : undefined
            if (tabResult.code !== 0 || !helper) {
              const helperClose = helper ? await closeRawHelper(helper) : undefined
              return {
                error: `${commandResultText('herdr tab create (raw helper)', tabResult)}${helperClose && !helperClose.closed ? ` ${helperClose.error || 'helper cleanup failed.'}` : ''}`,
                result: { argv: ['herdr', ...tabArgs], returned: payload, helperClose },
              }
            }
            const tabInspectionResult = await runHerdr(['tab', 'get', helper.tabId], signal, 10_000)
            const paneInspectionResult = await runHerdr(['pane', 'get', helper.paneId], signal, 10_000)
            const currentPaneResult = process.env.HERDR_PANE_ID ? await runHerdr(['pane', 'current', '--current'], signal, 10_000) : { stdout: '', stderr: '', code: 1 }
            const agentResult = await runHerdr(['agent', 'get', helper.paneId], signal, 10_000)
            const tabInspection = (parseJsonMaybe(tabInspectionResult.stdout) as { result?: { tab?: Record<string, unknown> } } | undefined)?.result?.tab
            const paneInspection = (parseJsonMaybe(paneInspectionResult.stdout) as { result?: { pane?: Record<string, unknown> } } | undefined)?.result?.pane
            const currentPane = (parseJsonMaybe(currentPaneResult.stdout) as { result?: { pane?: Record<string, unknown> } } | undefined)?.result?.pane
            const agent = (parseJsonMaybe(agentResult.stdout) as { result?: { agent?: Record<string, unknown> } } | undefined)?.result?.agent
            const exactRaw =
              tabInspectionResult.code === 0 &&
              !!tabInspection &&
              tabInspection.tab_id === helper.tabId &&
              tabInspection.workspace_id === workspaceId &&
              tabInspection.pane_count === 1 &&
              tabInspection.focused === false &&
              paneInspectionResult.code === 0 &&
              !!paneInspection &&
              paneInspection.pane_id === helper.paneId &&
              paneInspection.tab_id === helper.tabId &&
              paneInspection.workspace_id === workspaceId &&
              (paneInspection.cwd === cwd || paneInspection.foreground_cwd === cwd) &&
              currentPaneResult.code === 0 &&
              !!currentPane &&
              currentPane.pane_id === process.env.HERDR_PANE_ID &&
              currentPane.workspace_id === workspaceId &&
              currentPane.tab_id !== helper.tabId &&
              !(agentResult.code === 0 && agent)
            if (!exactRaw) {
              const close = await closeRawHelper(helper)
              return {
                error: `raw helper tab identity was incomplete or an agent occupied it.${close.closed ? '' : ` ${close.error || 'helper tab cleanup failed.'}`}`,
                result: { argv: ['herdr', ...tabArgs], returned: payload, tab: tabInspection, pane: paneInspection, currentPane, agent, helperClose: close },
              }
            }
            return { helper }
          }
          const removeTaskArtifacts = async (
            taskId: string,
            removeState = false,
          ): Promise<{ removed: string[]; missing: string[]; errors: Array<{ path: string; error: string }>; success: boolean }> => {
            const removed: string[] = []
            const missing: string[] = []
            const errors: Array<{ path: string; error: string }> = []
            for (const filePath of taskArtifactPaths(taskId, TASK_STATE_DIR)) {
              try {
                await fs.promises.unlink(filePath)
                removed.push(filePath)
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') missing.push(filePath)
                else errors.push({ path: filePath, error: (error as Error).message })
              }
            }
            if (removeState && errors.length === 0) {
              const statePath = taskFilePath(taskId)
              try {
                await fs.promises.unlink(statePath)
                removed.push(statePath)
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') missing.push(statePath)
                else errors.push({ path: statePath, error: (error as Error).message })
              }
            }
            return { removed, missing, errors, success: errors.length === 0 }
          }
          const reconcileFailedSharedTask = async (
            task: TaskRecord,
            outcome: 'blocked' | 'failed',
          ): Promise<{ task: TaskRecord; cleaned: boolean; artifacts?: { removed: string[]; missing: string[]; errors: Array<{ path: string; error: string }>; success: boolean }; guidance: string }> => {
            const preserve = async (message: string, endpointStatus: EndpointAbsenceStatus = task.endpointStatus || 'unverified') => {
              const pendingTask: TaskRecord = {
                ...task,
                status: task.worktreeProvider === 'herdr' ? 'failed' : task.status,
                cleanupStatus: 'pending',
                cleanupUpdatedAt: new Date().toISOString(),
                cleanupError: message,
                endpointStatus,
                error: message,
                updatedAt: new Date().toISOString(),
              }
              await writeTaskState(pendingTask).catch(() => undefined)
              return {
                task: pendingTask,
                cleaned: false,
                guidance:
                  task.worktreeProvider === 'treehouse'
                    ? 'Treehouse lease and worker changes were preserved. Resolve the worker or explicitly run task_abort/task_recover with force:true and discard:true to destructively return the lease.'
                    : 'Worker tab was not closed automatically. Inspect the durable record, then explicitly run task_abort/task_recover; use force:true only for intentional active/hung-worker recovery.',
              }
            }

            if (task.worktreeProvider !== 'herdr') {
              return await preserve(
                `reconciled ${outcome} report; automatic cleanup does not return Treehouse leases or discard worker changes.`,
                task.endpointStatus || 'recorded',
              )
            }
            if (
              typeof task.workspaceId !== 'string' ||
              !WORKSPACE_ID_RE.test(task.workspaceId) ||
              typeof task.tabId !== 'string' ||
              !TAB_ID_RE.test(task.tabId) ||
              typeof task.paneId !== 'string' ||
              !PANE_ID_RE.test(task.paneId) ||
              typeof task.workerName !== 'string' ||
              !AGENT_NAME_RE.test(task.workerName) ||
              task.workerName === FIRSTMATE_NAME ||
              typeof task.workerKind !== 'string' ||
              !AGENT_KIND_RE.test(task.workerKind)
            ) {
              return await preserve('automatic shared-task cleanup requires a complete exact recorded worker endpoint.', 'unverified')
            }

            const currentPaneId = process.env.HERDR_PANE_ID
            if (!currentPaneId || !PANE_ID_RE.test(currentPaneId)) return await preserve('automatic shared-task cleanup could not verify the current firstmate pane.', 'unverified')
            const currentPaneResult = await runHerdr(['pane', 'get', currentPaneId], signal, 10_000)
            const currentPane = (parseJsonMaybe(currentPaneResult.stdout) as { result?: { pane?: Record<string, unknown> } } | undefined)?.result?.pane
            if (
              currentPaneResult.code !== 0 ||
              !currentPane ||
              currentPane.pane_id !== currentPaneId ||
              currentPane.workspace_id !== task.workspaceId ||
              currentPane.tab_id === task.tabId
            ) {
              return await preserve('automatic shared-task cleanup could not establish a distinct current firstmate pane.', 'unverified')
            }

            const [tabResult, paneResult, agentResult] = await Promise.all([
              runHerdr(['tab', 'get', task.tabId], signal, 10_000),
              runHerdr(['pane', 'get', task.paneId], signal, 10_000),
              runHerdr(['agent', 'get', task.paneId], signal, 10_000),
            ])
            const tab = (parseJsonMaybe(tabResult.stdout) as { result?: { tab?: Record<string, unknown> } } | undefined)?.result?.tab
            const pane = (parseJsonMaybe(paneResult.stdout) as { result?: { pane?: Record<string, unknown> } } | undefined)?.result?.pane
            const agent = (parseJsonMaybe(agentResult.stdout) as { result?: { agent?: Record<string, unknown> } } | undefined)?.result?.agent
            const exactEndpoint =
              tabResult.code === 0 &&
              !!tab &&
              tab.tab_id === task.tabId &&
              tab.workspace_id === task.workspaceId &&
              tab.pane_count === 1 &&
              paneResult.code === 0 &&
              !!pane &&
              pane.pane_id === task.paneId &&
              pane.tab_id === task.tabId &&
              pane.workspace_id === task.workspaceId &&
              agentResult.code === 0 &&
              hasExactWorkerIdentity(
                { workspaceId: task.workspaceId, tabId: task.tabId, paneId: task.paneId, workerName: task.workerName, workerKind: task.workerKind },
                agent,
              )
            if (!exactEndpoint) return await preserve('automatic shared-task cleanup could not verify the exact recorded worker endpoint.', 'unverified')

            const statuses = {
              tab: typeof tab.agent_status === 'string' ? tab.agent_status : 'unknown',
              pane: typeof pane.agent_status === 'string' ? pane.agent_status : 'unknown',
              agent: typeof agent?.agent_status === 'string' ? agent.agent_status : 'unknown',
            }
            const unsafeStatus = Object.entries(statuses).find(([, status]) => status !== 'idle' && status !== 'done')
            if (unsafeStatus) {
              return await preserve(
                `automatic shared-task cleanup refused because ${unsafeStatus[0]} worker status is ${unsafeStatus[1]}; no force close was attempted.`,
                'recorded',
              )
            }

            const closeResult = await runHerdr(['tab', 'close', task.tabId], signal, 10_000)
            if (closeResult.code !== 0) return await preserve(commandResultText('herdr tab close (failed-report cleanup)', closeResult), 'recorded')
            const [verifyTabs, verifyPanes] = await Promise.all([
              runHerdr(['tab', 'list', '--workspace', task.workspaceId], signal, 10_000),
              runHerdr(['pane', 'list', '--workspace', task.workspaceId], signal, 10_000),
            ])
            const verifiedTabs = (parseJsonMaybe(verifyTabs.stdout) as { result?: { tabs?: unknown } } | undefined)?.result?.tabs
            const verifiedPanes = (parseJsonMaybe(verifyPanes.stdout) as { result?: { panes?: unknown } } | undefined)?.result?.panes
            if (
              !endpointListsConfirmAbsence({
                tabListSucceeded: verifyTabs.code === 0,
                paneListSucceeded: verifyPanes.code === 0,
                tabs: verifiedTabs,
                panes: verifiedPanes,
                tabId: task.tabId,
                paneId: task.paneId,
              })
            ) {
              return await preserve('worker tab close was acknowledged, but exact tab and pane absence was not verified.', 'recorded')
            }

            const terminalTask: TaskRecord = {
              ...task,
              status: 'failed',
              cleanupStatus: 'tab_closed',
              endpointStatus: 'absent_verified',
              cleanupUpdatedAt: new Date().toISOString(),
              cleanupError: undefined,
              error: `reconciled ${outcome} report; exact idle/done worker tab was safely closed.`,
              updatedAt: new Date().toISOString(),
            }
            try {
              await writeTaskState(terminalTask)
            } catch (error) {
              return await preserve(`worker tab was absent after cleanup, but terminal state could not be persisted: ${(error as Error).message}`, 'absent_verified')
            }
            const artifacts = await removeTaskArtifacts(task.taskId, false)
            if (!artifacts.success) {
              const retainedTask = { ...terminalTask, cleanupError: `task artifact cleanup failed: ${JSON.stringify(artifacts.errors)}`, updatedAt: new Date().toISOString() }
              await writeTaskState(retainedTask).catch(() => undefined)
              return {
                task: retainedTask,
                cleaned: false,
                artifacts,
                guidance: 'Worker tab cleanup was verified, but exact task artifact cleanup is incomplete; retry explicit recovery/cleanup while preserving the durable task record.',
              }
            }
            return {
              task: terminalTask,
              cleaned: true,
              artifacts,
              guidance: 'Exact idle/done worker tab closure and endpoint absence were verified; the durable terminal task record was retained and only exact task artifacts were removed.',
            }
          }

          const returnTaskLease = async (task: TaskRecord): Promise<{ returned: boolean; idempotent?: boolean; task: TaskRecord; error?: string; result?: Record<string, unknown> }> => {
            if (task.worktreeProvider !== 'treehouse') return { returned: true, idempotent: true, task }
            if (isPendingLeaseNoop(task.leaseStatus)) return { returned: true, idempotent: true, task }
            if (task.leaseReturnHelperTabId || task.leaseReturnHelperPaneId) {
              if (
                typeof task.leaseReturnHelperTabId !== 'string' ||
                !TAB_ID_RE.test(task.leaseReturnHelperTabId) ||
                typeof task.leaseReturnHelperPaneId !== 'string' ||
                !PANE_ID_RE.test(task.leaseReturnHelperPaneId) ||
                typeof task.workspaceId !== 'string' ||
                !WORKSPACE_ID_RE.test(task.workspaceId)
              )
                return { returned: false, task, error: 'durable Treehouse return helper identity is malformed; preserving task state.' }
              const helperClose = await closeRawHelper({ tabId: task.leaseReturnHelperTabId, paneId: task.leaseReturnHelperPaneId, workspaceId: task.workspaceId })
              if (!helperClose.closed)
                return { returned: false, task, error: helperClose.error || 'previous Treehouse return helper tab could not be closed; preserving task state.', result: { helperClose } }
              const clearedTask: TaskRecord = { ...task, leaseReturnHelperTabId: undefined, leaseReturnHelperPaneId: undefined, updatedAt: new Date().toISOString() }
              try {
                await writeTaskState(clearedTask)
              } catch (error) {
                return { returned: false, task, error: `could not persist Treehouse return helper cleanup: ${(error as Error).message}`, result: { helperClose } }
              }
              task = clearedTask
            }
            if (task.leaseStatus === 'returned' && task.leaseReturnStatus === 'returned') return { returned: true, idempotent: true, task }
            if (
              task.leaseStatus !== 'leased' ||
              typeof task.worktree !== 'string' ||
              !path.isAbsolute(task.worktree) ||
              task.leaseHolder !== task.taskId ||
              typeof task.leaseId !== 'string' ||
              !task.leaseId
            ) {
              return { returned: false, task, error: 'exact Treehouse lease identity is missing; preserving the lease.' }
            }
            const stdoutPath = path.join(TASK_STATE_DIR, `.${task.taskId}.lease-return.stdout`)
            const stderrPath = path.join(TASK_STATE_DIR, `.${task.taskId}.lease-return.stderr`)
            const statusPath = path.join(TASK_STATE_DIR, `.${task.taskId}.lease-return.status`)
            const command = `treehouse return --force ${shellQuote(task.worktree)} --if-lease-holder ${shellQuote(task.leaseHolder)} > ${shellQuote(stdoutPath)} 2> ${shellQuote(stderrPath)}; printf '%s\\n' "$?" > ${shellQuote(statusPath)}`
            const helperResult = await createRawHelper(task.workspaceId || '', task.worktree, `firstmate-lease-return-${task.taskId}`)
            if (!helperResult.helper)
              return { returned: false, task, error: helperResult.error || 'could not create raw Treehouse return helper tab; preserving the lease.', result: helperResult.result }
            const helper = helperResult.helper
            const helperTask: TaskRecord = { ...task, leaseReturnHelperTabId: helper.tabId, leaseReturnHelperPaneId: helper.paneId, updatedAt: new Date().toISOString() }
            try {
              await writeTaskState(helperTask)
            } catch (error) {
              const helperClose = await closeRawHelper(helper)
              return {
                returned: false,
                task,
                error: `could not persist Treehouse return helper identity: ${(error as Error).message}${helperClose.closed ? '' : ` ${helperClose.error || 'helper cleanup failed.'}`}`,
                result: { helperClose },
              }
            }
            task = helperTask
            const run = await runHerdr(['pane', 'run', helper.paneId, command], signal, 10_000)
            let statusText = ''
            let stdout = ''
            let stderr = ''
            let error: string | undefined
            if (run.code === 0) {
              try {
                statusText = await readPaneFile(statusPath)
              } catch (readError) {
                error = `Treehouse return result was ambiguous: ${(readError as Error).message}`
              }
            } else error = commandResultText('herdr pane run (Treehouse return)', run)
            stdout = await fs.promises.readFile(stdoutPath, 'utf8').catch(() => '')
            stderr = await fs.promises.readFile(stderrPath, 'utf8').catch(() => '')
            const code = statusText.trim() && /^-?\d+$/.test(statusText.trim()) ? Number.parseInt(statusText.trim(), 10) : null
            const returnSuccessMarker = [stdout, stderr].some((output) => output.includes(TREEHOUSE_RETURN_SUCCESS_MARKER))
            const markerSucceeded = code === null && returnSuccessMarker
            const commandSucceeded = (!error && code === 0) || markerSucceeded
            if (markerSucceeded) error = undefined
            if (!commandSucceeded && !error) error = `treehouse return exited ${code ?? 'unknown'}; lease is preserved.`
            const tempCleanup = await runHerdr(['pane', 'run', helper.paneId, `rm -f ${shellQuote(stdoutPath)} ${shellQuote(stderrPath)} ${shellQuote(statusPath)}`], signal, 10_000).catch(
              (cleanupError) => ({ stdout: '', stderr: (cleanupError as Error).message, code: 1 }),
            )
            const tempCleanupSucceeded = tempCleanup.code === 0
            const helperClose = tempCleanupSucceeded
              ? await closeRawHelper(helper)
              : { closed: false, error: 'Treehouse return temporary-result cleanup was not verified; preserving the return helper.', result: tempCleanup }
            if (!tempCleanupSucceeded) error = `${error ? `${error} ` : ''}${helperClose.error}`
            if (!helperClose.closed) error = `${error ? `${error} ` : ''}${helperClose.error || 'raw Treehouse return helper tab could not be closed.'}`
            const returned = canMarkLeaseReturned({ commandSucceeded, tempCleanupSucceeded, helperClosed: helperClose.closed })
            const updatedTask: TaskRecord = {
              ...task,
              leaseStatus: returned ? 'returned' : 'leased',
              leaseReturnStatus: returned ? 'returned' : 'failed',
              leaseReturnAt: new Date().toISOString(),
              leaseReturnCode: code,
              leaseReturnStdout: stdout,
              leaseReturnStderr: stderr,
              leaseReturnError: error,
              leaseReturnHelperTabId: returned ? undefined : helper.tabId,
              leaseReturnHelperPaneId: returned ? undefined : helper.paneId,
              updatedAt: new Date().toISOString(),
            }
            let persisted = true
            await writeTaskState(updatedTask).catch((persistError) => {
              persisted = false
              updatedTask.leaseStatus = 'leased'
              updatedTask.leaseReturnStatus = 'failed'
              updatedTask.leaseReturnError = `${error || ''}${error ? ' ' : ''}could not persist Treehouse return state: ${(persistError as Error).message}`
            })
            return {
              returned: returned && persisted,
              task: persisted ? updatedTask : task,
              error: updatedTask.leaseReturnError || (persisted ? undefined : 'could not persist Treehouse return state'),
              result: { argv: ['herdr', 'pane', 'run', helper.paneId, command], code, stdout, stderr, tempCleanup, helperClose },
            }
          }

          let args: string[]
          let tabCloseInspection: Record<string, unknown> | undefined
          let tabCloseTargetPaneId: string | undefined
          let tabCloseAgentName: string | undefined
          let tabCloseAgentKind: string | undefined
          let taskTeardownRecord: TaskRecord | undefined
          let taskTeardownReport: WorkerReport | undefined
          let taskTeardownTabAlreadyAbsent = false
          switch (params.action) {
            case 'status': {
              const workspaceId = process.env.HERDR_WORKSPACE_ID
              if (!workspaceId || !WORKSPACE_ID_RE.test(workspaceId)) return errorResult('HERDR_WORKSPACE_ID is missing or invalid.')
              const [workspaceList, currentPane, paneList, agentList, currentAgent] = await Promise.all([
                runHerdr(['workspace', 'list'], signal, 10_000),
                runHerdr(['pane', 'current', '--current'], signal, 10_000),
                runHerdr(['pane', 'list', '--workspace', workspaceId], signal, 10_000),
                runHerdr(['agent', 'list'], signal, 10_000),
                process.env.HERDR_PANE_ID ? runHerdr(['agent', 'get', process.env.HERDR_PANE_ID], signal, 10_000) : Promise.resolve({ stdout: '', stderr: '', code: 1 }),
              ])
              await deriveCurrentAgentKind(signal).catch(() => undefined)
              let durableTasks: Record<string, unknown>
              try {
                let readDiagnostic: string | undefined
                const taskRecords = await readWatcherTaskRecords((error, filePath) => {
                  readDiagnostic ||= `task-state read failed for ${filePath}: ${(error as Error).message}`
                })
                durableTasks = readDiagnostic ? { error: readDiagnostic } : durableTaskSummary(taskRecords)
              } catch (error) {
                durableTasks = { error: `task-state read failed: ${(error as Error).message}` }
              }
              const details = {
                action: params.action,
                workspaceId,
                paneId: process.env.HERDR_PANE_ID,
                currentAgentKind,
                selectedWorkerKind,
                watcher: watcherDetails(),
                durableTasks,
                workspaceList: parseJsonMaybe(workspaceList.stdout) ?? workspaceList,
                currentPane: parseJsonMaybe(currentPane.stdout) ?? currentPane,
                paneList: parseJsonMaybe(paneList.stdout) ?? paneList,
                agentList: parseJsonMaybe(agentList.stdout) ?? agentList,
                currentAgent: parseJsonMaybe(currentAgent.stdout) ?? currentAgent,
              }
              return {
                content: [{ type: 'text' as const, text: JSON.stringify(details, null, 2) }],
                details,
              }
            }
            case 'task_create': {
              if (!params.project) return errorResult('`project` is required for task_create.', { action: params.action })
              const projectError = validateOptionalCwd(params.project)
              if (projectError) return errorResult(projectError, { action: params.action })
              if (!params.prompt) return errorResult('`prompt` is required for task_create.', { action: params.action })
              const taskWorkerKind = params.kind === undefined ? selectedWorkerKind : params.kind
              const taskWorkerKindError = validateWorkerKind(taskWorkerKind)
              if (taskWorkerKindError) return errorResult(taskWorkerKindError, { action: params.action, kind: params.kind })
              const reviewTargetError = validateOptionalCwd(params.reviewTarget)
              if (reviewTargetError) return errorResult(reviewTargetError, { action: params.action })
              if (params.reviewTarget !== undefined && !params.reviewTarget.trim()) return errorResult('`reviewTarget` must be a non-empty ref when provided.', { action: params.action })

              let project = path.resolve(ctx.cwd, params.project)
              const taskIsolation = isolationMode
              if (taskIsolation === 'shared') {
                try {
                  project = await fs.promises.realpath(project)
                } catch (error) {
                  return errorResult(`shared-checkout project is not accessible: ${(error as Error).message}`, { action: params.action, project })
                }
              }
              if (taskIsolation === 'shared' && params.reviewTarget !== undefined) {
                return errorResult('reviewTarget tasks require worktree isolation; switch with /firstmate-isolation worktree.', { action: params.action, project, reviewTarget: params.reviewTarget })
              }
              if (taskIsolation === 'shared') {
                try {
                  releaseSharedAdmission = (await acquireSharedAdmissionLock(project)).release
                } catch (error) {
                  return errorResult(`shared-checkout admission is unavailable: ${(error as Error).message}`, { action: params.action, project })
                }
                const sharedTasks = (await readWatcherTaskRecords()).filter(
                  (record) =>
                    record.project === project &&
                    record.worktreeProvider === 'herdr' &&
                    record.cleanupStatus !== 'tab_closed',
                )
                for (const sharedTask of sharedTasks) {
                  if (
                    sharedTask.cleanupStatus === 'pending' &&
                    (sharedTask.reportStatus === 'failed' || sharedTask.reportStatus === 'blocked')
                  ) {
                    return errorResult('a failed or blocked shared task still requires explicit task_abort/task_recover; automatic cleanup was unsafe or incomplete and the durable record is preserved.', {
                      action: params.action,
                      project,
                      activeTaskId: sharedTask.taskId,
                      task: sharedTask,
                    })
                  }
                  if (sharedTask.status === 'provisioning' && !sharedTask.tabId && !sharedTask.paneId) {
                    if (!canDeleteWithoutRecordedEndpoint(sharedTask.endpointStatus)) {
                      return errorResult('unstarted shared task has no verified endpoint absence; preserving the durable record for explicit recovery.', {
                        action: params.action,
                        project,
                        activeTaskId: sharedTask.taskId,
                        task: sharedTask,
                      })
                    }
                    const artifactCleanup = await removeTaskArtifacts(sharedTask.taskId, true)
                    if (!artifactCleanup.success) {
                      await writeTaskState({
                        ...sharedTask,
                        status: 'failed',
                        endpointStatus: 'unverified',
                        cleanupError: `provisioning artifact cleanup failed: ${JSON.stringify(artifactCleanup.errors)}`,
                        updatedAt: new Date().toISOString(),
                      }).catch(() => undefined)
                      return errorResult('unstarted shared task cleanup failed; preserving the record for retry.', { action: params.action, project, activeTaskId: sharedTask.taskId, artifactCleanup })
                    }
                    continue
                  }
                  const completeRecordedEndpoint =
                    typeof sharedTask.workspaceId === 'string' &&
                    sharedTask.workspaceId === process.env.HERDR_WORKSPACE_ID &&
                    typeof sharedTask.paneId === 'string' &&
                    PANE_ID_RE.test(sharedTask.paneId) &&
                    typeof sharedTask.tabId === 'string' &&
                    TAB_ID_RE.test(sharedTask.tabId) &&
                    typeof sharedTask.workerName === 'string' &&
                    AGENT_NAME_RE.test(sharedTask.workerName) &&
                    sharedTask.workerName !== FIRSTMATE_NAME &&
                    typeof sharedTask.workerKind === 'string' &&
                    AGENT_KIND_RE.test(sharedTask.workerKind)
                  const recordedAgentResult = completeRecordedEndpoint
                    ? await runHerdr(['agent', 'get', sharedTask.paneId!], signal, 5_000).catch(() => ({ stdout: '', stderr: '', code: 1 }))
                    : { stdout: '', stderr: '', code: 1 }
                  const recordedAgent = (parseJsonMaybe(recordedAgentResult.stdout) as { result?: { agent?: Record<string, unknown> } } | undefined)?.result?.agent
                  const currentFirstmateEndpoint =
                    sharedTask.reportStatus === 'completed' &&
                    completeRecordedEndpoint &&
                    isCurrentFirstmateOccupyingRecordedEndpoint(
                      {
                        workspaceId: sharedTask.workspaceId!,
                        tabId: sharedTask.tabId!,
                        paneId: sharedTask.paneId!,
                        workerName: sharedTask.workerName!,
                        workerKind: sharedTask.workerKind!,
                      },
                      recordedAgentResult.code === 0 ? recordedAgent : undefined,
                      process.env.HERDR_PANE_ID,
                    )
                  const liveEndpoint =
                    completeRecordedEndpoint &&
                    recordedAgentResult.code === 0 &&
                    hasExactWorkerIdentity(
                      {
                        workspaceId: sharedTask.workspaceId!,
                        tabId: sharedTask.tabId!,
                        paneId: sharedTask.paneId!,
                        workerName: sharedTask.workerName!,
                        workerKind: sharedTask.workerKind!,
                      },
                      recordedAgent,
                    )
                  if (liveEndpoint) {
                    return errorResult('a shared-checkout task is already active for this project; use task_abort/task_recover for stale or blocked work, or switch to worktree isolation.', {
                      action: params.action,
                      project,
                      activeTaskId: sharedTask.taskId,
                    })
                  }
                  let endpointAbsent = currentFirstmateEndpoint
                  if (!currentFirstmateEndpoint) {
                    const [tabListResult, paneListResult] = await Promise.all([
                      typeof sharedTask.workspaceId === 'string' ? runHerdr(['tab', 'list', '--workspace', sharedTask.workspaceId], signal, 5_000) : Promise.resolve({ stdout: '', stderr: '', code: 1 }),
                      typeof sharedTask.workspaceId === 'string'
                        ? runHerdr(['pane', 'list', '--workspace', sharedTask.workspaceId], signal, 5_000)
                        : Promise.resolve({ stdout: '', stderr: '', code: 1 }),
                    ])
                    const tabs = (parseJsonMaybe(tabListResult.stdout) as { result?: { tabs?: unknown } } | undefined)?.result?.tabs
                    const panes = (parseJsonMaybe(paneListResult.stdout) as { result?: { panes?: unknown } } | undefined)?.result?.panes
                    endpointAbsent =
                      tabListResult.code === 0 &&
                      paneListResult.code === 0 &&
                      Array.isArray(tabs) &&
                      Array.isArray(panes) &&
                      !tabs.some((entry) => isRecord(entry) && entry.tab_id === sharedTask.tabId) &&
                      !panes.some((entry) => isRecord(entry) && entry.pane_id === sharedTask.paneId)
                  }
                  if (!endpointAbsent) {
                    return errorResult('a stale shared-checkout task still has an unverified endpoint; run task_abort/task_recover and preserve the durable record until absence is verified.', {
                      action: params.action,
                      project,
                      activeTaskId: sharedTask.taskId,
                    })
                  }
                  const staleTask = {
                    ...sharedTask,
                    status: 'failed' as const,
                    cleanupStatus: 'tab_closed' as const,
                    endpointStatus: 'absent_verified' as const,
                    cleanupError: undefined,
                    error: currentFirstmateEndpoint
                      ? 'recorded worker endpoint is occupied by the current firstmate; recovered during shared-task admission.'
                      : 'recorded worker endpoint is absent; recovered during shared-task admission.',
                    updatedAt: new Date().toISOString(),
                  }
                  await writeTaskState(staleTask)
                  const artifactCleanup = await removeTaskArtifacts(sharedTask.taskId, true)
                  if (!artifactCleanup.success) {
                    await writeTaskState({
                      ...staleTask,
                      cleanupError: `stale shared-task artifact cleanup failed: ${JSON.stringify(artifactCleanup.errors)}`,
                      updatedAt: new Date().toISOString(),
                    }).catch(() => undefined)
                    return errorResult('stale shared task endpoint is absent, but durable artifact cleanup failed; preserving the record for retry.', {
                      action: params.action,
                      project,
                      activeTaskId: sharedTask.taskId,
                      artifactCleanup,
                    })
                  }
                }
              }
              const taskId = newTaskId()
              const reportPath = reportFilePath(taskId)
              const branch = `firstmate/${taskId}`
              const workerName = `worker-${taskId.slice('task-'.length)}`
              const now = new Date().toISOString()
              let task: TaskRecord = {
                version: TASK_VERSION,
                taskId,
                project,
                worktree: taskIsolation === 'shared' ? project : null,
                worktreeProvider: taskIsolation === 'shared' ? 'herdr' : 'treehouse',
                ...(taskIsolation === 'worktree' ? { leaseStatus: 'pending' as const, leaseHolder: taskId } : {}),
                workspaceId: null,
                tabId: null,
                paneId: null,
                branch,
                ...(params.reviewTarget !== undefined ? { reviewTarget: params.reviewTarget } : {}),
                workerKind: taskWorkerKind,
                status: 'provisioning',
                reportPath,
                reportStatus: 'pending',
                cleanupStatus: 'pending',
                endpointStatus: 'unverified',
                createdAt: now,
                updatedAt: now,
              }
              let taskPath: string
              try {
                taskPath = await writeTaskState(task)
              } catch (error) {
                return errorResult(`could not persist task state: ${(error as Error).message}`, { action: params.action, taskId, project })
              }

              const failTask = async (message: string, details: Record<string, unknown> = {}) => {
                task = { ...task, status: 'failed', error: message, updatedAt: new Date().toISOString() }
                await writeTaskState(task).catch(() => undefined)
                return errorResult(message, { action: params.action, taskId, taskPath, task, ...details })
              }

              const kind = taskWorkerKind
              if (!AGENT_NAME_RE.test(workerName)) return failTask('generated worker name is invalid.')

              const workspaceId = process.env.HERDR_WORKSPACE_ID
              if (!workspaceId || !WORKSPACE_ID_RE.test(workspaceId)) return failTask('HERDR_WORKSPACE_ID is missing or invalid.')

              const tabArgs = [
                'tab',
                'create',
                '--workspace',
                workspaceId,
                '--cwd',
                project,
                '--label',
                params.label || taskId,
                '--env',
                `${WORKER_ENV}=1`,
                '--env',
                `${TASK_ENV}=${taskId}`,
                '--env',
                `${REPORT_ENV}=${reportPath}`,
                '--env',
                `PATH=${workerPath()}`,
                '--env',
                `PI_FIRSTMATE_REAL_GIT=${firstmateGitPath()}`,
                '--no-focus',
              ]
              const tabResult = await runHerdr(tabArgs, signal, timeout)
              const tabPayload = parseJsonMaybe(tabResult.stdout) as
                | {
                    result?: {
                      tab?: { tab_id?: unknown; workspace_id?: unknown; focused?: unknown; pane_count?: unknown }
                      root_pane?: { pane_id?: unknown; tab_id?: unknown; workspace_id?: unknown; cwd?: unknown }
                    }
                  }
                | undefined
              const created = tabPayload?.result
              const returnedTab = created?.tab
              const returnedRootPane = created?.root_pane
              const returnedTabId = returnedTab?.tab_id
              const returnedPaneId = returnedRootPane?.pane_id
              if (tabResult.code !== 0) {
                const orphanCleanup =
                  typeof returnedTabId === 'string' && TAB_ID_RE.test(returnedTabId) && typeof returnedPaneId === 'string' && PANE_ID_RE.test(returnedPaneId)
                    ? await closeRawHelper({ tabId: returnedTabId, paneId: returnedPaneId, workspaceId })
                    : undefined
                task = { ...task, endpointStatus: orphanCleanup?.closed ? 'absent_verified' : 'unverified', updatedAt: new Date().toISOString() }
                return failTask(commandResultText('herdr tab create', tabResult), { argv: ['herdr', ...tabArgs], returned: tabPayload, orphanCleanup })
              }

              const currentPaneId = process.env.HERDR_PANE_ID
              const currentPaneResult = currentPaneId ? await runHerdr(['pane', 'current', '--current'], signal, 10_000) : { stdout: '', stderr: '', code: 1 }
              const currentPanePayload = parseJsonMaybe(currentPaneResult.stdout) as { result?: { pane?: Record<string, unknown> } } | undefined
              const currentPane = currentPanePayload?.result?.pane
              const tabInspectionResult = typeof returnedTabId === 'string' ? await runHerdr(['tab', 'get', returnedTabId], signal, 10_000) : { stdout: '', stderr: '', code: 1 }
              const paneInspectionResult = typeof returnedPaneId === 'string' ? await runHerdr(['pane', 'get', returnedPaneId], signal, 10_000) : { stdout: '', stderr: '', code: 1 }
              const tabInspection = (parseJsonMaybe(tabInspectionResult.stdout) as { result?: { tab?: Record<string, unknown> } } | undefined)?.result?.tab
              const paneInspection = (parseJsonMaybe(paneInspectionResult.stdout) as { result?: { pane?: Record<string, unknown> } } | undefined)?.result?.pane
              if (
                typeof returnedTabId !== 'string' ||
                !TAB_ID_RE.test(returnedTabId) ||
                typeof returnedPaneId !== 'string' ||
                !PANE_ID_RE.test(returnedPaneId) ||
                returnedTab?.workspace_id !== workspaceId ||
                returnedRootPane?.tab_id !== returnedTabId ||
                returnedRootPane?.workspace_id !== workspaceId ||
                tabInspectionResult.code !== 0 ||
                tabInspection?.tab_id !== returnedTabId ||
                tabInspection.workspace_id !== workspaceId ||
                tabInspection.pane_count !== 1 ||
                tabInspection.focused !== false ||
                paneInspectionResult.code !== 0 ||
                paneInspection?.pane_id !== returnedPaneId ||
                paneInspection.tab_id !== returnedTabId ||
                paneInspection.workspace_id !== workspaceId ||
                paneInspection.cwd !== project ||
                currentPaneResult.code !== 0 ||
                !currentPane ||
                currentPane.pane_id !== currentPaneId ||
                currentPane.workspace_id !== workspaceId ||
                currentPane.tab_id === returnedTabId
              ) {
                const orphanCleanup =
                  typeof returnedTabId === 'string' && TAB_ID_RE.test(returnedTabId) && typeof returnedPaneId === 'string' && PANE_ID_RE.test(returnedPaneId)
                    ? await closeRawHelper({ tabId: returnedTabId, paneId: returnedPaneId, workspaceId })
                    : undefined
                task = { ...task, endpointStatus: orphanCleanup?.closed ? 'absent_verified' : 'unverified', updatedAt: new Date().toISOString() }
                return failTask('herdr tab create returned incomplete or inconsistent current-workspace tab, root pane, cwd, or no-focus identity.', {
                  argv: ['herdr', ...tabArgs],
                  returned: tabPayload,
                  currentPane: currentPanePayload,
                  tabInspection: parseJsonMaybe(tabInspectionResult.stdout),
                  paneInspection: parseJsonMaybe(paneInspectionResult.stdout),
                  orphanCleanup,
                })
              }

              task = {
                ...task,
                workspaceId,
                tabId: returnedTabId,
                paneId: returnedPaneId,
                endpointStatus: 'recorded',
                updatedAt: new Date().toISOString(),
              }
              try {
                await writeTaskState(task)
              } catch (error) {
                const orphanCleanup =
                  typeof returnedTabId === 'string' && TAB_ID_RE.test(returnedTabId) && typeof returnedPaneId === 'string' && PANE_ID_RE.test(returnedPaneId)
                    ? await closeRawHelper({ tabId: returnedTabId, paneId: returnedPaneId, workspaceId })
                    : undefined
                task = { ...task, endpointStatus: orphanCleanup?.closed ? 'absent_verified' : 'unverified', updatedAt: new Date().toISOString() }
                return failTask(`could not persist worker tab identity: ${(error as Error).message}`, { argv: ['herdr', ...tabArgs], returned: tabPayload, orphanCleanup })
              }

              const leaseJsonPath = path.join(TASK_STATE_DIR, `.${taskId}.lease.json`)
              const leaseErrorPath = path.join(TASK_STATE_DIR, `.${taskId}.lease.stderr`)
              const leaseStatusPath = path.join(TASK_STATE_DIR, `.${taskId}.lease.status`)
              const removeLeaseTemp = async (): Promise<ExecResult> =>
                await runHerdr(['pane', 'run', returnedPaneId, `rm -f ${shellQuote(leaseJsonPath)} ${shellQuote(leaseErrorPath)} ${shellQuote(leaseStatusPath)}`], signal, 10_000)
              const readPaneFile = async (filePath: string): Promise<string> => {
                const deadline = Date.now() + timeout
                while (Date.now() < deadline) {
                  try {
                    return await fs.promises.readFile(filePath, 'utf8')
                  } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
                  }
                  await new Promise((resolve) => setTimeout(resolve, 100))
                }
                throw new Error(`timed out waiting for ${filePath}`)
              }

              const closeProvisionedTab = async (): Promise<Record<string, unknown>> => {
                const currentId = process.env.HERDR_PANE_ID
                if (!currentId || !PANE_ID_RE.test(currentId)) return { closed: false, error: 'current firstmate pane id is invalid' }
                const currentResult = await runHerdr(['pane', 'get', currentId], signal, 10_000)
                const current = (parseJsonMaybe(currentResult.stdout) as { result?: { pane?: Record<string, unknown> } } | undefined)?.result?.pane
                const targetTabResult = await runHerdr(['tab', 'get', returnedTabId], signal, 10_000)
                const targetTab = (parseJsonMaybe(targetTabResult.stdout) as { result?: { tab?: Record<string, unknown> } } | undefined)?.result?.tab
                const panesResult = await runHerdr(['pane', 'list', '--workspace', workspaceId], signal, 10_000)
                const panes = (parseJsonMaybe(panesResult.stdout) as { result?: { panes?: Array<Record<string, unknown>> } } | undefined)?.result?.panes
                const targetPanes = panes?.filter((pane) => pane.tab_id === returnedTabId) ?? []
                const targetPaneId = targetPanes.length === 1 ? targetPanes[0].pane_id : undefined
                const agentResult = typeof targetPaneId === 'string' ? await runHerdr(['agent', 'get', targetPaneId], signal, 10_000) : { stdout: '', stderr: '', code: 1 }
                const agent = (parseJsonMaybe(agentResult.stdout) as { result?: { agent?: Record<string, unknown> } } | undefined)?.result?.agent
                if (
                  currentResult.code !== 0 ||
                  !current ||
                  current.pane_id !== currentId ||
                  current.workspace_id !== workspaceId ||
                  current.tab_id === returnedTabId ||
                  targetTabResult.code !== 0 ||
                  !targetTab ||
                  targetTab.tab_id !== returnedTabId ||
                  targetTab.workspace_id !== workspaceId ||
                  targetTab.pane_count !== 1 ||
                  panesResult.code !== 0 ||
                  targetPanes.length !== 1 ||
                  typeof targetPaneId !== 'string' ||
                  !PANE_ID_RE.test(targetPaneId) ||
                  (agentResult.code === 0 && agent && agent.agent_status !== 'idle' && agent.agent_status !== 'done')
                ) {
                  return { closed: false, error: 'refused to close a non-exact or agent-occupied provisioned tab', current, targetTab, targetPanes, agent }
                }
                const closeResult = await runHerdr(['tab', 'close', returnedTabId], signal, 10_000)
                if (closeResult.code !== 0) return { closed: false, result: closeResult, error: 'provisioned tab close was not acknowledged' }
                const [verifyTabs, verifyPanes] = await Promise.all([
                  runHerdr(['tab', 'list', '--workspace', workspaceId], signal, 10_000),
                  runHerdr(['pane', 'list', '--workspace', workspaceId], signal, 10_000),
                ])
                const verifiedTabs = (parseJsonMaybe(verifyTabs.stdout) as { result?: { tabs?: unknown } } | undefined)?.result?.tabs
                const verifiedPanes = (parseJsonMaybe(verifyPanes.stdout) as { result?: { panes?: unknown } } | undefined)?.result?.panes
                const verifiedAbsent = endpointListsConfirmAbsence({
                  tabListSucceeded: verifyTabs.code === 0,
                  paneListSucceeded: verifyPanes.code === 0,
                  tabs: verifiedTabs,
                  panes: verifiedPanes,
                  tabId: returnedTabId,
                  paneId: String(targetPaneId),
                })
                return { closed: verifiedAbsent, result: closeResult, error: verifiedAbsent ? undefined : 'provisioned tab close was not verified absent' }
              }
              const failAfterTab = async (message: string, details: Record<string, unknown> = {}) => {
                const cleanup = await closeProvisionedTab()
                const leaseReturn = cleanup.closed
                  ? await returnTaskLease(task)
                  : { returned: false, attempted: task.worktreeProvider === 'treehouse', error: 'worker tab was not verified closed; lease was not returned.', task }
                const tempCleanup = await removeTaskArtifacts(taskId, false)
                const cleanupErrors = [
                  typeof leaseReturn.error === 'string' ? leaseReturn.error : undefined,
                  cleanup.closed ? undefined : String(cleanup.error || 'provisioned tab cleanup failed'),
                  tempCleanup.success ? undefined : `task temporary artifact cleanup failed: ${JSON.stringify(tempCleanup.errors)}`,
                ].filter((error): error is string => Boolean(error))
                task = {
                  ...task,
                  endpointStatus: cleanup.closed ? 'absent_verified' : 'unverified',
                  cleanupStatus: cleanup.closed && leaseReturn.returned && tempCleanup.success ? 'tab_closed' : task.cleanupStatus,
                  cleanupError: cleanupErrors.length ? cleanupErrors.join(' ') : undefined,
                  updatedAt: new Date().toISOString(),
                }
                const failureMessage = leaseReturn.attempted && leaseReturn.returned !== true ? `${message} Treehouse lease return failed or was ambiguous; the lease remains retained.` : message
                const failure = await failTask(failureMessage, { ...details, leaseReturn, tempCleanup, cleanup })
                if (cleanup.closed && leaseReturn.returned && tempCleanup.success) {
                  const artifactCleanup = await removeTaskArtifacts(taskId, true)
                  if (failure.details && typeof failure.details === 'object')
                    Object.assign(failure.details as Record<string, unknown>, { artifactsRemoved: artifactCleanup.removed, artifactsMissing: artifactCleanup.missing, artifactCleanup })
                }
                return failure
              }

              const envArgs = [
                'pane',
                'run',
                returnedPaneId,
                `export ${WORKER_ENV}=1 ${TASK_ENV}=${shellQuote(taskId)} ${REPORT_ENV}=${shellQuote(reportPath)} PI_FIRSTMATE_REAL_GIT=${shellQuote(firstmateGitPath())} PATH=${shellQuote(workerPath())}`,
              ]
              const envResult = await runHerdr(envArgs, signal, 10_000)
              if (envResult.code !== 0) {
                return failAfterTab(commandResultText('herdr pane run (worker environment)', envResult), { argv: ['herdr', ...envArgs] })
              }

              if (taskIsolation === 'worktree') {
                const leaseArgs = ['get', '--lease', '--lease-holder', taskId, '--json']
                const leaseCommand = `treehouse ${leaseArgs.map(shellQuote).join(' ')} > ${shellQuote(leaseJsonPath)} 2> ${shellQuote(leaseErrorPath)}; printf '%s\\n' "$?" > ${shellQuote(leaseStatusPath)}`
                const leaseRunArgs = ['pane', 'run', returnedPaneId, leaseCommand]
                const leaseRunResult = await runHerdr(leaseRunArgs, signal, 10_000)
                if (leaseRunResult.code !== 0) return failAfterTab(commandResultText('herdr pane run (Treehouse lease)', leaseRunResult), { argv: ['herdr', ...leaseRunArgs] })

                let leaseStatusText: string
                try {
                  leaseStatusText = await readPaneFile(leaseStatusPath)
                } catch (error) {
                  return failAfterTab(`Treehouse lease command did not report completion: ${(error as Error).message}`, { argv: ['herdr', ...leaseRunArgs] })
                }
                let leaseJsonText: string
                try {
                  leaseJsonText = await fs.promises.readFile(leaseJsonPath, 'utf8')
                } catch (error) {
                  const stderr = await fs.promises.readFile(leaseErrorPath, 'utf8').catch(() => '')
                  return failAfterTab(`treehouse get --lease failed with status ${leaseStatusText.trim()}: ${stderr.trim() || (error as Error).message}`, { argv: ['herdr', ...leaseRunArgs] })
                }
                const leasePayload = parseJsonMaybe(leaseJsonText) as { path?: unknown; lease_id?: unknown; lease_holder?: unknown } | undefined
                const returnedWorktree = leasePayload?.path
                const leaseId = typeof leasePayload?.lease_id === 'string' ? leasePayload.lease_id : undefined
                const leaseHolder = typeof leasePayload?.lease_holder === 'string' ? leasePayload.lease_holder : undefined
                if (
                  leaseStatusText.trim() !== '0' ||
                  typeof returnedWorktree !== 'string' ||
                  !path.isAbsolute(returnedWorktree) ||
                  returnedWorktree.includes('\u0000') ||
                  typeof leaseId !== 'string' ||
                  !leaseId ||
                  leaseHolder !== taskId
                ) {
                  const stderr = await fs.promises.readFile(leaseErrorPath, 'utf8').catch(() => '')
                  return failAfterTab('treehouse lease returned incomplete or inconsistent path, lease id, or lease-holder identity.', {
                    argv: ['herdr', ...leaseRunArgs],
                    returned: leasePayload,
                    status: leaseStatusText.trim(),
                    stderr: stderr.trim(),
                  })
                }
                try {
                  const worktreeStat = await fs.promises.stat(returnedWorktree)
                  if (!worktreeStat.isDirectory()) throw new Error('leased path is not a directory')
                } catch (error) {
                  return failAfterTab(`leased Treehouse worktree is not accessible: ${(error as Error).message}`, { argv: ['herdr', ...leaseRunArgs], returned: leasePayload })
                }

                task = { ...task, worktree: returnedWorktree, leaseStatus: 'leased', leaseId, leaseHolder, status: 'worktree_leased', updatedAt: new Date().toISOString() }
                try {
                  await writeTaskState(task)
                } catch (error) {
                  return failAfterTab(`could not persist Treehouse lease identity: ${(error as Error).message}`, { argv: ['herdr', ...leaseRunArgs], returned: leasePayload })
                }

                const removeLeaseTempResult = await removeLeaseTemp()
                if (removeLeaseTempResult.code !== 0)
                  return failAfterTab(commandResultText('herdr pane run (lease temp cleanup)', removeLeaseTempResult), { argv: ['herdr', 'pane', 'run', returnedPaneId, 'rm -f <lease temp files>'] })

                const cdArgs = ['pane', 'run', returnedPaneId, `cd ${shellQuote(returnedWorktree)}`]
                const cdResult = await runHerdr(cdArgs, signal, 10_000)
                if (cdResult.code !== 0) return failAfterTab(commandResultText('herdr pane run (worker cwd)', cdResult), { argv: ['herdr', ...cdArgs] })
                const cwdResult = await runHerdr(['pane', 'get', returnedPaneId], signal, 10_000)
                const cwdPane = (parseJsonMaybe(cwdResult.stdout) as { result?: { pane?: Record<string, unknown> } } | undefined)?.result?.pane
                if (
                  cwdResult.code !== 0 ||
                  !cwdPane ||
                  cwdPane.pane_id !== returnedPaneId ||
                  cwdPane.tab_id !== returnedTabId ||
                  cwdPane.workspace_id !== workspaceId ||
                  cwdPane.foreground_cwd !== returnedWorktree
                ) {
                  return failAfterTab('worker pane did not enter the exact leased Treehouse worktree.', { argv: ['herdr', 'pane', 'get', returnedPaneId], cwd: parseJsonMaybe(cwdResult.stdout) })
                }

                const branchSetupCommand = treehouseWorkerBranchCommand(branch, task.reviewTarget)
                const branchSetupArgs = ['pane', 'run', returnedPaneId, branchSetupCommand]
                const branchSetupResult = await runHerdr(branchSetupArgs, signal, timeout)
                if (branchSetupResult.code !== 0) {
                  return failAfterTab(commandResultText('herdr pane run (worker branch setup)', branchSetupResult), { argv: ['herdr', ...branchSetupArgs] })
                }
              }

              task = { ...task, workerName, workerKind: kind, status: 'starting', updatedAt: new Date().toISOString() }
              try {
                await writeTaskState(task)
              } catch (error) {
                return failAfterTab(`could not persist worker identity: ${(error as Error).message}`)
              }

              const startArgs = ['agent', 'start', workerName, '--kind', kind, '--pane', returnedPaneId]
              if (params.timeoutMs !== undefined) startArgs.push('--timeout', String(params.timeoutMs))
              appendWorkerNativeArgs(startArgs, kind)
              let startResult = await runHerdr(startArgs, signal, timeout)
              let startAttempt = 1
              while (isRetryableAgentStartFailure(startResult) && startAttempt < 10) {
                const delayMs = Math.min(250 * 2 ** (startAttempt - 1), 4_000)
                await new Promise((resolve) => setTimeout(resolve, delayMs))
                startAttempt += 1
                startResult = await runHerdr(startArgs, signal, timeout)
              }
              if (startResult.code !== 0) {
                return failAfterTab(commandResultText('herdr agent start', startResult), { argv: ['herdr', ...startArgs] })
              }

              task = { ...task, status: 'started', updatedAt: new Date().toISOString() }
              let stateWriteError: string | undefined
              try {
                await writeTaskState(task)
              } catch (error) {
                stateWriteError = (error as Error).message
                return failAfterTab(`could not persist started worker state: ${stateWriteError}`, { argv: ['herdr', ...startArgs], stateWriteError })
              }

              const reviewPrompt = task.reviewTarget ? `\n\nThis is a review task. Inspect the existing target ref ${task.reviewTarget}; do not silently review the default branch.` : ''
              const workerPrompt = `${params.prompt}${reviewPrompt}${workerReportContract(taskId, reportPath)}`
              const promptArgs = ['agent', 'prompt', workerName, workerPrompt]
              const promptResult = await runHerdr(promptArgs, signal, timeout)
              if (promptResult.code !== 0) {
                const promptError = commandResultText('herdr agent prompt', promptResult)
                return failAfterTab('worker started but its prompt could not be delivered.', { argv: ['herdr', ...promptArgs], promptError, stateWriteError })
              }

              const details = {
                action: params.action,
                taskId,
                taskPath,
                task,
                isolation: taskIsolation,
                argv: {
                  tab: ['herdr', ...tabArgs],
                  environment: ['herdr', ...envArgs],
                  ...(taskIsolation === 'worktree'
                    ? { provisioning: 'Treehouse lease, worker cwd, and branch setup completed.' }
                    : { provisioning: 'Worker started in the requested shared checkout.' }),
                  start: ['herdr', ...startArgs],
                  prompt: ['herdr', ...promptArgs],
                },
                stateWriteError,
              }
              return { content: [{ type: 'text' as const, text: `Worker started and working. Task ID: ${taskId}.` }], details }
            }
            case 'task_reconcile': {
              const taskIdError = validateTaskId(params.taskId)
              if (taskIdError) return errorResult(taskIdError, { action: params.action, taskId: params.taskId })
              const taskId = params.taskId!
              const task = await readTaskState(taskId)
              if (!task || task.taskId !== taskId) {
                return errorResult('durable task state is absent or malformed.', { action: params.action, taskId, taskPath: taskFilePath(taskId) })
              }
              const reportPath = reportFilePath(taskId)
              if (task.reportPath !== reportPath) {
                return errorResult('durable task state has an unexpected report path.', { action: params.action, taskId, taskPath: taskFilePath(taskId), expectedReportPath: reportPath, task })
              }
              if (task.status === 'failed' && task.cleanupStatus === 'tab_closed' && (task.reportStatus === 'failed' || task.reportStatus === 'blocked')) {
                const guidance = 'This failed/blocked task already has verified terminal worker cleanup. Use task_abort/task_recover only to finish any retained exact artifacts; no task_teardown is required.'
                const details = { action: params.action, taskId, taskPath: taskFilePath(taskId), reportPath, complete: false, reconciled: true, task, nextAction: guidance }
                return errorResult(`worker report outcome is ${task.reportOutcome || task.reportStatus}; task is not complete. ${guidance}`, details)
              }

              let reportText: string
              try {
                reportText = await fs.promises.readFile(reportPath, 'utf8')
              } catch (error) {
                const message = `worker report is missing or unreadable: ${(error as Error).message}`
                const updatedTask = {
                  ...task,
                  reportStatus: 'missing' as const,
                  reportOutcome: undefined,
                  reportUpdatedAt: new Date().toISOString(),
                  reportSummary: undefined,
                  reportError: message,
                  updatedAt: new Date().toISOString(),
                }
                await writeTaskState(updatedTask).catch(() => undefined)
                return errorResult(message, { action: params.action, taskId, taskPath: taskFilePath(taskId), reportPath, complete: false, reconciled: false, task: updatedTask })
              }

              let parsedReport: unknown
              try {
                parsedReport = JSON.parse(reportText)
              } catch (error) {
                const message = `worker report is malformed JSON: ${(error as Error).message}`
                const updatedTask = {
                  ...task,
                  reportStatus: 'malformed' as const,
                  reportOutcome: undefined,
                  reportUpdatedAt: new Date().toISOString(),
                  reportSummary: undefined,
                  reportError: message,
                  updatedAt: new Date().toISOString(),
                }
                await writeTaskState(updatedTask).catch(() => undefined)
                return errorResult(message, { action: params.action, taskId, taskPath: taskFilePath(taskId), reportPath, complete: false, reconciled: false, task: updatedTask })
              }

              const validation = validateWorkerReport(parsedReport, taskId)
              if (!validation.report) {
                const message = `worker report is malformed: ${validation.error}`
                const updatedTask = {
                  ...task,
                  reportStatus: 'malformed' as const,
                  reportOutcome: undefined,
                  reportUpdatedAt: new Date().toISOString(),
                  reportSummary: undefined,
                  reportError: message,
                  updatedAt: new Date().toISOString(),
                }
                await writeTaskState(updatedTask).catch(() => undefined)
                return errorResult(message, { action: params.action, taskId, taskPath: taskFilePath(taskId), reportPath, complete: false, reconciled: false, task: updatedTask, report: parsedReport })
              }

              const report = validation.report
              const reconciledTask: TaskRecord = {
                ...task,
                reportStatus: report.outcome,
                reportOutcome: report.outcome,
                reportUpdatedAt: new Date().toISOString(),
                reportSummary: report.summary,
                reportError: undefined,
                updatedAt: new Date().toISOString(),
              }
              try {
                await writeTaskState(reconciledTask)
              } catch (error) {
                return errorResult(`could not persist report reconciliation: ${(error as Error).message}`, {
                  action: params.action,
                  taskId,
                  taskPath: taskFilePath(taskId),
                  reportPath,
                  complete: false,
                  reconciled: false,
                  task,
                  report,
                })
              }

              if (report.outcome !== 'completed') {
                const cleanup = await reconcileFailedSharedTask(reconciledTask, report.outcome)
                const failedDetails = {
                  action: params.action,
                  taskId,
                  taskPath: taskFilePath(taskId),
                  reportPath,
                  complete: false,
                  reconciled: true,
                  task: cleanup.task,
                  report,
                  cleanup: {
                    attempted: cleanup.task.worktreeProvider === 'herdr',
                    cleaned: cleanup.cleaned,
                    artifacts: cleanup.artifacts,
                    guidance: cleanup.guidance,
                  },
                  nextAction: cleanup.guidance,
                }
                return errorResult(`worker report outcome is ${report.outcome}; task is not complete. ${cleanup.guidance}`, failedDetails)
              }
              const details = { action: params.action, taskId, taskPath: taskFilePath(taskId), reportPath, complete: true, reconciled: true, task: reconciledTask, report }
              return { content: [{ type: 'text' as const, text: JSON.stringify(report, null, 2) }], details }
            }
            case 'task_deliver': {
              const taskIdError = validateTaskId(params.taskId)
              if (taskIdError) return errorResult(taskIdError, { action: params.action, taskId: params.taskId })
              if (!params.project) return errorResult('`project` is required for task_deliver.', { action: params.action })
              const projectError = validateOptionalCwd(params.project)
              if (projectError) return errorResult(projectError, { action: params.action })
              const taskId = params.taskId!
              const taskPath = taskFilePath(taskId)
              const reportPath = reportFilePath(taskId)
              let task = await readTaskState(taskId)
              if (!task || task.version !== TASK_VERSION || task.taskId !== taskId) return errorResult('durable task state is absent or malformed.', { action: params.action, taskId, taskPath })
              if (task.project !== path.resolve(ctx.cwd, params.project))
                return errorResult('requested primary project does not exactly match the durable task project.', {
                  action: params.action,
                  taskId,
                  task,
                  requestedProject: path.resolve(ctx.cwd, params.project),
                })
              if (task.reportPath !== reportPath)
                return errorResult('durable task state has an unexpected report path.', { action: params.action, taskId, taskPath, expectedReportPath: reportPath, task })
              if (task.worktreeProvider === 'herdr')
                return errorResult('shared-checkout tasks are already local and must not use task_deliver; reconcile, then use task_teardown.', { action: params.action, taskId, task })
              if (
                task.status !== 'started' ||
                task.worktreeProvider !== 'treehouse' ||
                typeof task.worktree !== 'string' ||
                !path.isAbsolute(task.worktree) ||
                (task.leaseStatus !== 'leased' && task.leaseStatus !== 'returned') ||
                task.leaseHolder !== taskId ||
                typeof task.leaseId !== 'string' ||
                !task.leaseId ||
                typeof task.workspaceId !== 'string' ||
                !WORKSPACE_ID_RE.test(task.workspaceId) ||
                typeof task.tabId !== 'string' ||
                !TAB_ID_RE.test(task.tabId) ||
                typeof task.paneId !== 'string' ||
                !PANE_ID_RE.test(task.paneId) ||
                typeof task.workerName !== 'string' ||
                !AGENT_NAME_RE.test(task.workerName) ||
                task.workerName === FIRSTMATE_NAME ||
                typeof task.workerKind !== 'string' ||
                !AGENT_KIND_RE.test(task.workerKind)
              ) {
                return errorResult('task delivery requires the exact Treehouse lease, worker endpoint, and worker branch identity.', { action: params.action, taskId, task })
              }
              if (task.branch !== `firstmate/${taskId}`) return errorResult('durable task branch is not the generated exact worker branch.', { action: params.action, taskId, task })
              if (task.reviewTarget) return errorResult('review tasks are inspection-only and cannot be locally delivered.', { action: params.action, taskId, task })
              if (task.deliveryStatus !== 'landed' && task.leaseStatus !== 'leased')
                return errorResult('an undelivered task must still hold its active Treehouse lease.', { action: params.action, taskId, task })

              let reportText: string
              try {
                reportText = await fs.promises.readFile(reportPath, 'utf8')
              } catch (error) {
                return errorResult(`worker report is missing or unreadable: ${(error as Error).message}`, { action: params.action, taskId, reportPath, reconciled: false, complete: false, task })
              }
              let parsedReport: unknown
              try {
                parsedReport = JSON.parse(reportText)
              } catch (error) {
                return errorResult(`worker report is malformed JSON: ${(error as Error).message}`, { action: params.action, taskId, reportPath, reconciled: false, complete: false, task })
              }
              const reportValidation = validateWorkerReport(parsedReport, taskId)
              if (
                !reportValidation.report ||
                reportValidation.report.outcome !== 'completed' ||
                task.reportStatus !== 'completed' ||
                task.reportOutcome !== 'completed' ||
                typeof task.reportUpdatedAt !== 'string' ||
                task.reportSummary !== reportValidation.report.summary
              ) {
                return errorResult('task delivery requires a reconciled completed worker report.', { action: params.action, taskId, task, report: parsedReport, reconciled: false, complete: false })
              }

              if (task.deliveryHelperTabId || task.deliveryHelperPaneId) {
                if (
                  typeof task.deliveryHelperTabId !== 'string' ||
                  !TAB_ID_RE.test(task.deliveryHelperTabId) ||
                  typeof task.deliveryHelperPaneId !== 'string' ||
                  !PANE_ID_RE.test(task.deliveryHelperPaneId) ||
                  typeof task.workspaceId !== 'string' ||
                  !WORKSPACE_ID_RE.test(task.workspaceId)
                )
                  return errorResult('durable delivery helper identity is malformed; preserving task state.', { action: params.action, taskId, task })
                const helperClose = await closeRawHelper({ tabId: task.deliveryHelperTabId, paneId: task.deliveryHelperPaneId, workspaceId: task.workspaceId })
                if (!helperClose.closed)
                  return errorResult(helperClose.error || 'previous delivery helper tab could not be closed; preserving task state.', { action: params.action, taskId, task, helperClose })
                const clearedTask: TaskRecord = { ...task, deliveryHelperTabId: undefined, deliveryHelperPaneId: undefined, updatedAt: new Date().toISOString() }
                try {
                  await writeTaskState(clearedTask)
                } catch (error) {
                  return errorResult(`could not persist delivery helper cleanup: ${(error as Error).message}`, { action: params.action, taskId, task, helperClose })
                }
                task = clearedTask
              }
              if (
                task.deliveryStatus === 'landed' &&
                typeof (task.deliveryTargetBranch || task.deliveryDefaultBranch) === 'string' &&
                typeof task.deliveryCommit === 'string' &&
                typeof task.deliveryAt === 'string'
              ) {
                const details = { action: params.action, taskId, taskPath, reportPath, delivered: true, idempotent: true, task, report: reportValidation.report }
                return { content: [{ type: 'text' as const, text: JSON.stringify(details, null, 2) }], details }
              }

              const workspaceId = process.env.HERDR_WORKSPACE_ID
              if (!workspaceId || !WORKSPACE_ID_RE.test(workspaceId) || task.workspaceId !== workspaceId)
                return errorResult('Treehouse task is outside the current firstmate workspace.', { action: params.action, taskId, task, currentWorkspaceId: workspaceId })
              const currentPaneId = process.env.HERDR_PANE_ID
              const currentPaneError = validatePaneId(currentPaneId, 'HERDR_PANE_ID')
              if (currentPaneError) return errorResult(currentPaneError, { action: params.action, taskId, task })
              const currentPaneResult = await runHerdr(['pane', 'get', currentPaneId!], signal, 10_000)
              const currentPane = (parseJsonMaybe(currentPaneResult.stdout) as { result?: { pane?: Record<string, unknown> } } | undefined)?.result?.pane
              if (
                currentPaneResult.code !== 0 ||
                !currentPane ||
                currentPane.pane_id !== currentPaneId ||
                currentPane.workspace_id !== workspaceId ||
                typeof currentPane.tab_id !== 'string' ||
                !TAB_ID_RE.test(currentPane.tab_id) ||
                currentPane.tab_id === task.tabId
              )
                return errorResult('could not establish an exact non-worker firstmate pane.', { action: params.action, taskId, task, currentPane: parseJsonMaybe(currentPaneResult.stdout) })
              const targetPaneResult = await runHerdr(['pane', 'get', task.paneId || ''], signal, 10_000)
              const targetPane = (parseJsonMaybe(targetPaneResult.stdout) as { result?: { pane?: Record<string, unknown> } } | undefined)?.result?.pane
              const agentResult = await runHerdr(['agent', 'get', task.paneId || ''], signal, 10_000)
              const agent = (parseJsonMaybe(agentResult.stdout) as { result?: { agent?: Record<string, unknown> } } | undefined)?.result?.agent
              if (
                targetPaneResult.code !== 0 ||
                !targetPane ||
                targetPane.pane_id !== task.paneId ||
                targetPane.tab_id !== task.tabId ||
                targetPane.workspace_id !== task.workspaceId ||
                agentResult.code !== 0 ||
                !agent ||
                agent.pane_id !== task.paneId ||
                agent.tab_id !== task.tabId ||
                agent.workspace_id !== task.workspaceId ||
                agent.name !== task.workerName ||
                agent.agent !== task.workerKind ||
                task.workerName === FIRSTMATE_NAME
              ) {
                return errorResult('live worker endpoint does not match the exact durable Treehouse task identity.', {
                  action: params.action,
                  taskId,
                  task,
                  targetPane: parseJsonMaybe(targetPaneResult.stdout),
                  agent: parseJsonMaybe(agentResult.stdout),
                })
              }

              const evidencePath = path.join(TASK_STATE_DIR, `.${taskId}.delivery.evidence`)
              const dirtyPathsPath = path.join(TASK_STATE_DIR, `.${taskId}.delivery.dirty-paths`)
              const workerPathsPath = path.join(TASK_STATE_DIR, `.${taskId}.delivery.worker-paths`)
              const dirtyPathOverlapCheck = [
                'try{',
                "const fs=require('node:fs');",
                'const paths=(file)=>{const bytes=fs.readFileSync(file);const entries=[];let start=0;for(let index=0;index<bytes.length;index+=1){if(bytes[index]===0){entries.push(bytes.subarray(start,index));start=index+1}}return entries};',
                "const key=(entry)=>entry.toString('hex');",
                'const dirtyEntries=paths(process.argv[1]);const dirty=new Set(dirtyEntries.map(key));const dirtyAncestors=new Set();',
                'for(const entry of dirtyEntries){for(let index=0;index<entry.length;index+=1){if(entry[index]===47)dirtyAncestors.add(key(entry.subarray(0,index)))} }',
                'const overlaps=paths(process.argv[2]).some((entry)=>{const entryKey=key(entry);if(dirty.has(entryKey)||dirtyAncestors.has(entryKey))return true;for(let index=0;index<entry.length;index+=1){if(entry[index]===47&&dirty.has(key(entry.subarray(0,index))))return true}return false});process.exit(overlaps?1:0)',
                '}catch{process.exit(2)}',
              ].join('')
              const stdoutPath = path.join(TASK_STATE_DIR, `.${taskId}.delivery.stdout`)
              const stderrPath = path.join(TASK_STATE_DIR, `.${taskId}.delivery.stderr`)
              const statusPath = path.join(TASK_STATE_DIR, `.${taskId}.delivery.status`)
              const deliveryScriptPath = path.join(TASK_STATE_DIR, `.${taskId}.delivery.sh`)
              const deliveryScript =
                [
                  '#!/bin/sh',
                  `project=${shellQuote(task.project)}`,
                  `branch=${shellQuote(task.branch)}`,
                  `evidence=${shellQuote(evidencePath)}`,
                  `dirty_paths=${shellQuote(dirtyPathsPath)}`,
                  `worker_paths=${shellQuote(workerPathsPath)}`,
                  'target_ref=$(git -C "$project" symbolic-ref --quiet HEAD 2>/dev/null || true)',
                  'case "$target_ref" in refs/heads/*) target="${target_ref#refs/heads/}";; *) target=;; esac',
                  'if git -C "$project" show-ref --verify --quiet "refs/heads/$branch"; then branch_exists=true; else branch_exists=false; fi',
                  'dirty_paths_check=not-applicable',
                  'dirty_paths_overlap=false',
                  'if ! { git -C "$project" diff --name-only -z; git -C "$project" diff --cached --name-only -z; git -C "$project" ls-files --others --exclude-standard -z; } > "$dirty_paths"; then dirty_paths_check=failed; elif [ -n "$target" ] && [ "$branch_exists" = true ]; then if git -C "$project" diff --name-only --no-renames -z "$target" "$branch" > "$worker_paths"; then dirty_paths_check=complete; else dirty_paths_check=failed; fi; fi',
                  `if [ "$dirty_paths_check" = complete ] && [ -s "$dirty_paths" ] && [ -s "$worker_paths" ]; then if ${shellQuote(process.execPath)} -e ${shellQuote(dirtyPathOverlapCheck)} "$dirty_paths" "$worker_paths"; then dirty_paths_overlap=false; else case "$?" in 1) dirty_paths_overlap=true;; *) dirty_paths_check=failed;; esac; fi; fi`,
                  'if [ -n "$target" ] && [ "$branch_exists" = true ] && git -C "$project" merge-base --is-ancestor "$target" "$branch"; then fast_forward=true; else fast_forward=false; fi',
                  'printf \'target=%s\\ndirty_paths_check=%s\\ndirty_paths_overlap=%s\\nbranch_exists=%s\\nfast_forward=%s\\n\' "$target" "$dirty_paths_check" "$dirty_paths_overlap" "$branch_exists" "$fast_forward" > "$evidence"',
                  'if [ -z "$target" ] || [ "$dirty_paths_check" = failed ] || [ "$dirty_paths_overlap" != false ] || [ "$branch_exists" != true ] || [ "$fast_forward" != true ]; then echo \'refusing local delivery: primary checkout is detached, the dirty-path check failed, dirty paths overlap the worker branch, the recorded worker branch is missing, or branches have diverged\' >&2; code=1; else before=$(git -C "$project" rev-parse "$target"); git -C "$project" merge --ff-only "$branch"; code=$?; if [ "$code" -eq 0 ]; then after=$(git -C "$project" rev-parse "$target"); printf \'before=%s\\nafter=%s\\n\' "$before" "$after" >> "$evidence"; fi; fi',
                  '[ "$code" -eq 0 ]',
                ].join('\n') + '\n'
              try {
                await fs.promises.mkdir(TASK_STATE_DIR, { recursive: true, mode: 0o700 })
                await fs.promises.writeFile(deliveryScriptPath, deliveryScript, { encoding: 'utf8', mode: 0o700 })
                await fs.promises.chmod(deliveryScriptPath, 0o700)
              } catch (error) {
                await fs.promises.unlink(deliveryScriptPath).catch(() => undefined)
                return errorResult(`could not persist delivery helper script: ${(error as Error).message}`, { action: params.action, taskId, task })
              }
              const deliveryCommand = `sh ${shellQuote(deliveryScriptPath)} > ${shellQuote(stdoutPath)} 2> ${shellQuote(stderrPath)}; printf '%s\\n' "$?" > ${shellQuote(statusPath)}`
              const landingTask: TaskRecord = { ...task, deliveryStatus: 'landing', deliveryAt: new Date().toISOString(), deliveryError: undefined, updatedAt: new Date().toISOString() }
              try {
                await writeTaskState(landingTask)
              } catch (error) {
                await fs.promises.unlink(deliveryScriptPath).catch(() => undefined)
                return errorResult(`could not persist delivery state before landing: ${(error as Error).message}`, { action: params.action, taskId, task })
              }
              const helperResult = await createRawHelper(workspaceId, task.project, `firstmate-delivery-${taskId}`)
              if (!helperResult.helper) {
                const failedTask: TaskRecord = {
                  ...landingTask,
                  deliveryStatus: 'failed',
                  deliveryError: helperResult.error || 'could not create raw delivery helper tab.',
                  updatedAt: new Date().toISOString(),
                }
                await writeTaskState(failedTask).catch(() => undefined)
                await fs.promises.unlink(deliveryScriptPath).catch(() => undefined)
                return errorResult(failedTask.deliveryError || 'could not create raw delivery helper tab.', { action: params.action, taskId, task: failedTask, helper: helperResult.result })
              }
              const helper = helperResult.helper
              const landingTaskWithHelper: TaskRecord = { ...landingTask, deliveryHelperTabId: helper.tabId, deliveryHelperPaneId: helper.paneId, updatedAt: new Date().toISOString() }
              try {
                await writeTaskState(landingTaskWithHelper)
              } catch (error) {
                const helperClose = await closeRawHelper(helper)
                await fs.promises.unlink(deliveryScriptPath).catch(() => undefined)
                return errorResult(`could not persist delivery helper identity: ${(error as Error).message}${helperClose.closed ? '' : ` ${helperClose.error || 'helper cleanup failed.'}`}`, {
                  action: params.action,
                  taskId,
                  task: landingTask,
                  helperClose,
                })
              }
              task = landingTaskWithHelper
              const deliveryRun = await runHerdr(['pane', 'run', helper.paneId, deliveryCommand], signal, timeout)
              let statusText = ''
              let evidenceText = ''
              let stdout = ''
              let stderr = ''
              let deliveryError: string | undefined
              if (deliveryRun.code === 0) {
                try {
                  statusText = await readPaneFile(statusPath)
                  evidenceText = await fs.promises.readFile(evidencePath, 'utf8').catch(() => '')
                  stdout = await fs.promises.readFile(stdoutPath, 'utf8').catch(() => '')
                  stderr = await fs.promises.readFile(stderrPath, 'utf8').catch(() => '')
                } catch (error) {
                  deliveryError = `local delivery result was ambiguous: ${(error as Error).message}`
                }
              } else deliveryError = commandResultText('herdr pane run (local delivery)', deliveryRun)
              const values = Object.fromEntries(
                evidenceText.split(/\r?\n/).flatMap((line) => {
                  const separator = line.indexOf('=')
                  return separator > 0 ? [[line.slice(0, separator), line.slice(separator + 1)]] : []
                }),
              )
              const resultCode = statusText.trim() && /^-?\d+$/.test(statusText.trim()) ? Number.parseInt(statusText.trim(), 10) : null
              const deliveryDecision = assessLocalDelivery({
                targetBranch: values.target || '',
                dirtyPathCheckSucceeded: values.dirty_paths_check === 'complete',
                dirtyPathsOverlap: values.dirty_paths_overlap === 'true',
                branchExists: values.branch_exists === 'true',
                fastForward: values.fast_forward === 'true',
              })
              const refused = deliveryDecision.allowed
                ? undefined
                : deliveryDecision.reason === 'detached'
                  ? 'primary checkout is detached or not on a local branch'
                  : deliveryDecision.reason === 'dirty-path-check-failed'
                    ? 'could not safely compare primary dirty paths with the worker branch'
                    : deliveryDecision.reason === 'dirty-overlap'
                      ? 'primary checkout has dirty paths overlapping the worker branch'
                      : deliveryDecision.reason === 'missing-branch'
                        ? 'recorded worker branch is missing'
                        : 'primary and worker branches have diverged'
              const before = values.before
              const after = values.after
              const mergeSuccess =
                !deliveryError &&
                resultCode === 0 &&
                !refused &&
                typeof values.target === 'string' &&
                values.target.length > 0 &&
                typeof before === 'string' &&
                /^[0-9a-f]+$/i.test(before) &&
                typeof after === 'string' &&
                /^[0-9a-f]+$/i.test(after)
              const tempCleanup = await runHerdr(
                [
                  'pane',
                  'run',
                  helper.paneId,
                  `rm -f ${shellQuote(deliveryScriptPath)} ${shellQuote(evidencePath)} ${shellQuote(dirtyPathsPath)} ${shellQuote(workerPathsPath)} ${shellQuote(stdoutPath)} ${shellQuote(stderrPath)} ${shellQuote(statusPath)}`,
                ],
                signal,
                10_000,
              ).catch((cleanupError) => ({ stdout: '', stderr: (cleanupError as Error).message, code: 1 }))
              const deliveryTempCleanupSucceeded = tempCleanup.code === 0
              if (deliveryTempCleanupSucceeded) await fs.promises.unlink(deliveryScriptPath).catch(() => undefined)
              const helperClose = deliveryTempCleanupSucceeded
                ? await closeRawHelper(helper)
                : { closed: false, error: 'delivery temporary-result cleanup was not verified; preserving the delivery helper.', result: tempCleanup }
              if (!deliveryTempCleanupSucceeded) deliveryError = `${deliveryError ? `${deliveryError} ` : ''}${helperClose.error}`
              if (!helperClose.closed) deliveryError = `${deliveryError ? `${deliveryError} ` : ''}${helperClose.error || 'raw delivery helper tab could not be closed.'}`
              const deliverySuccess = mergeSuccess && deliveryTempCleanupSucceeded && helperClose.closed
              const finalTask: TaskRecord = {
                ...task,
                deliveryStatus: deliverySuccess ? 'landed' : 'failed',
                deliveryTargetBranch: values.target,
                deliveryDefaultBranch: undefined,
                deliveryBeforeCommit: before,
                deliveryCommit: after,
                deliveryCode: resultCode,
                deliveryStdout: stdout,
                deliveryStderr: stderr,
                deliveryError: deliverySuccess ? undefined : deliveryError || refused || 'local delivery failed or returned incomplete evidence',
                deliveryHelperTabId: helperClose.closed ? undefined : helper.tabId,
                deliveryHelperPaneId: helperClose.closed ? undefined : helper.paneId,
                updatedAt: new Date().toISOString(),
              }
              let deliveryPersistError: string | undefined
              await writeTaskState(finalTask).catch((error) => {
                deliveryPersistError = `could not persist delivery result: ${(error as Error).message}`
              })
              if (!deliverySuccess || deliveryPersistError)
                return errorResult(deliveryPersistError || finalTask.deliveryError || 'local delivery failed.', {
                  action: params.action,
                  taskId,
                  taskPath,
                  project: task.project,
                  branch: task.branch,
                  task: finalTask,
                  delivery: { result: deliveryRun, evidence: values, tempCleanup, helperClose, durableEvidence: !deliveryPersistError },
                })
              const details = {
                action: params.action,
                taskId,
                taskPath,
                project: task.project,
                branch: task.branch,
                delivered: true,
                idempotent: false,
                task: finalTask,
                report: reportValidation.report,
                delivery: { targetBranch: values.target, beforeCommit: before, landedCommit: after, stdout, stderr },
              }
              return { content: [{ type: 'text' as const, text: JSON.stringify(details, null, 2) }], details }
            }
            case 'task_abort':
            case 'task_recover': {
              const taskIdError = validateTaskId(params.taskId)
              if (taskIdError) return errorResult(taskIdError, { action: params.action, taskId: params.taskId })
              const taskId = params.taskId!
              const taskPath = taskFilePath(taskId)
              const task = await readTaskState(taskId)
              if (!task || task.version !== TASK_VERSION || task.taskId !== taskId) return errorResult('durable task state is absent or malformed.', { action: params.action, taskId, taskPath })
              if (task.reportPath !== reportFilePath(taskId)) return errorResult('durable task state has an unexpected report path.', { action: params.action, taskId, taskPath, task })
              if (params.discard && !params.force) return errorResult('`discard` requires explicit `force: true`.', { action: params.action, taskId, task })
              if (task.worktreeProvider === 'treehouse' && task.leaseStatus === 'leased' && !params.discard)
                return errorResult('leased worktree recovery requires explicit discard: true because returning it may discard worker changes.', { action: params.action, taskId, task })
              if (!task.workspaceId && !task.tabId && !task.paneId && task.leaseStatus !== 'leased') {
                if (!canDeleteWithoutRecordedEndpoint(task.endpointStatus)) {
                  return errorResult('task has no recorded endpoint but durable endpoint absence was not explicitly verified; preserving state.', { action: params.action, taskId, task })
                }
                const recoveredTask = {
                  ...task,
                  status: 'failed' as const,
                  cleanupStatus: 'tab_closed' as const,
                  endpointStatus: 'absent_verified' as const,
                  cleanupUpdatedAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                }
                await writeTaskState(recoveredTask)
                const artifactCleanup = await removeTaskArtifacts(taskId, true)
                if (!artifactCleanup.success) {
                  const retainedTask = { ...recoveredTask, cleanupError: `artifact cleanup failed: ${JSON.stringify(artifactCleanup.errors)}`, updatedAt: new Date().toISOString() }
                  await writeTaskState(retainedTask).catch(() => undefined)
                  return errorResult('task has no recorded endpoint, but artifact cleanup is incomplete; durable state is retained.', {
                    action: params.action,
                    taskId,
                    task: retainedTask,
                    artifactCleanup,
                  })
                }
                const details = { action: params.action, taskId, task: recoveredTask, endpointAbsent: true, artifactsRemoved: artifactCleanup.removed, artifactsMissing: artifactCleanup.missing }
                return { content: [{ type: 'text' as const, text: JSON.stringify(details, null, 2) }], details }
              }
              const workspaceId = process.env.HERDR_WORKSPACE_ID
              if (!workspaceId || !WORKSPACE_ID_RE.test(workspaceId) || task.workspaceId !== workspaceId)
                return errorResult('task recovery requires the recorded worker workspace to be the current firstmate workspace.', { action: params.action, taskId, task, workspaceId })
              const currentPaneId = process.env.HERDR_PANE_ID
              const currentPaneError = validatePaneId(currentPaneId, 'HERDR_PANE_ID')
              if (currentPaneError) return errorResult(currentPaneError, { action: params.action, taskId, task })
              const currentPaneResult = await runHerdr(['pane', 'get', currentPaneId!], signal, 10_000)
              const currentPane = (parseJsonMaybe(currentPaneResult.stdout) as { result?: { pane?: Record<string, unknown> } } | undefined)?.result?.pane
              if (currentPaneResult.code !== 0 || !currentPane || currentPane.pane_id !== currentPaneId || currentPane.workspace_id !== workspaceId || currentPane.tab_id === task.tabId)
                return errorResult('could not establish a distinct current firstmate pane before recovery.', {
                  action: params.action,
                  taskId,
                  task,
                  currentPane: parseJsonMaybe(currentPaneResult.stdout),
                })

              const [tabListResult, paneListResult] = await Promise.all([
                runHerdr(['tab', 'list', '--workspace', workspaceId], signal, 10_000),
                runHerdr(['pane', 'list', '--workspace', workspaceId], signal, 10_000),
              ])
              const tabs = (parseJsonMaybe(tabListResult.stdout) as { result?: { tabs?: unknown } } | undefined)?.result?.tabs
              const panes = (parseJsonMaybe(paneListResult.stdout) as { result?: { panes?: unknown } } | undefined)?.result?.panes
              if (tabListResult.code !== 0 || paneListResult.code !== 0 || !Array.isArray(tabs) || !Array.isArray(panes))
                return errorResult('could not verify the recorded worker endpoint; preserving durable state.', {
                  action: params.action,
                  taskId,
                  task,
                  tabList: tabListResult,
                  paneList: paneListResult,
                })
              let tab = tabs.find((entry) => isRecord(entry) && entry.tab_id === task.tabId) as Record<string, unknown> | undefined
              let pane = panes.find((entry) => isRecord(entry) && entry.pane_id === task.paneId) as Record<string, unknown> | undefined
              if (tab && (!pane || pane.tab_id !== task.tabId))
                return errorResult('recorded worker tab has an ambiguous or mismatched pane; preserving durable state.', { action: params.action, taskId, task, tab, pane })
              if (pane && (!tab || pane.tab_id !== task.tabId))
                return errorResult('recorded worker pane has no exact recorded tab; preserving durable state.', { action: params.action, taskId, task, tab, pane })
              if (!tab && !pane) {
                // Exact absence is a supported recovery result; no stop command is needed.
              } else {
                const targetPaneResult = await runHerdr(['pane', 'get', task.paneId || ''], signal, 10_000)
                const targetPane = (parseJsonMaybe(targetPaneResult.stdout) as { result?: { pane?: Record<string, unknown> } } | undefined)?.result?.pane
                const agentResult = await runHerdr(['agent', 'get', task.paneId || ''], signal, 10_000)
                const agent = (parseJsonMaybe(agentResult.stdout) as { result?: { agent?: Record<string, unknown> } } | undefined)?.result?.agent
                const exactAgent =
                  agentResult.code === 0 &&
                  hasExactWorkerIdentity({ workspaceId, tabId: task.tabId!, paneId: task.paneId!, workerName: task.workerName || '', workerKind: task.workerKind || '' }, agent)
                if (!targetPane || targetPaneResult.code !== 0 || targetPane.pane_id !== task.paneId || targetPane.tab_id !== task.tabId || targetPane.workspace_id !== workspaceId)
                  return errorResult('recorded worker pane could not be verified exactly; preserving durable state.', {
                    action: params.action,
                    taskId,
                    task,
                    targetPane: parseJsonMaybe(targetPaneResult.stdout),
                    agent: parseJsonMaybe(agentResult.stdout),
                  })
                if (!exactAgent && !params.force)
                  return errorResult('recorded worker agent identity is missing or mismatched; refusing an unforced tab close and preserving durable state.', {
                    action: params.action,
                    taskId,
                    task,
                    targetPane: parseJsonMaybe(targetPaneResult.stdout),
                    agent: parseJsonMaybe(agentResult.stdout),
                  })
                const statuses = [tab?.agent_status, pane?.agent_status, exactAgent ? agent.agent_status : undefined].filter((status): status is string => typeof status === 'string')
                const active = exactAgent && statuses.some((status) => status !== 'idle' && status !== 'done')
                if (active && !params.force)
                  return errorResult('worker is active or hung; retry with explicit force: true to close its pane. Herdr has no native agent stop command.', {
                    action: params.action,
                    taskId,
                    task,
                    statuses,
                  })
                const closeResult = params.force ? await runHerdr(['pane', 'close', task.paneId!], signal, 10_000) : await runHerdr(['tab', 'close', task.tabId!], signal, 10_000)
                if (closeResult.code !== 0)
                  return errorResult(commandResultText(params.force ? 'herdr pane close (forced recovery)' : 'herdr tab close (recovery)', closeResult), {
                    action: params.action,
                    taskId,
                    task,
                    statuses,
                    force: params.force,
                  })
                const verifyAfterClose = async (): Promise<{ tabAbsent: boolean; paneAbsent: boolean; tabs: unknown; panes: unknown }> => {
                  const [nextTabs, nextPanes] = await Promise.all([
                    runHerdr(['tab', 'list', '--workspace', workspaceId], signal, 10_000),
                    runHerdr(['pane', 'list', '--workspace', workspaceId], signal, 10_000),
                  ])
                  const nextTabEntries = (parseJsonMaybe(nextTabs.stdout) as { result?: { tabs?: unknown } } | undefined)?.result?.tabs
                  const nextPaneEntries = (parseJsonMaybe(nextPanes.stdout) as { result?: { panes?: unknown } } | undefined)?.result?.panes
                  return {
                    tabAbsent: nextTabs.code === 0 && Array.isArray(nextTabEntries) && !nextTabEntries.some((entry) => isRecord(entry) && entry.tab_id === task.tabId),
                    paneAbsent: nextPanes.code === 0 && Array.isArray(nextPaneEntries) && !nextPaneEntries.some((entry) => isRecord(entry) && entry.pane_id === task.paneId),
                    tabs: nextTabEntries,
                    panes: nextPaneEntries,
                  }
                }
                let absence = await verifyAfterClose()
                if (!absence.paneAbsent && params.force)
                  return errorResult('forced pane close did not verify the worker pane absent; preserving durable state.', { action: params.action, taskId, task, absence })
                if (!params.force && !absence.tabAbsent && absence.paneAbsent) {
                  const tabCloseResult = await runHerdr(['tab', 'close', task.tabId!], signal, 10_000)
                  if (tabCloseResult.code !== 0) return errorResult(commandResultText('herdr tab close after pane close', tabCloseResult), { action: params.action, taskId, task, absence })
                  absence = await verifyAfterClose()
                }
                if (!absence.tabAbsent || !absence.paneAbsent)
                  return errorResult('worker endpoint cleanup was not verified; preserving durable state.', { action: params.action, taskId, task, absence })
                tab = undefined
                pane = undefined
              }
              let recoveredTask = {
                ...task,
                status: 'failed' as const,
                cleanupStatus: 'tab_closed' as const,
                endpointStatus: 'absent_verified' as const,
                cleanupUpdatedAt: new Date().toISOString(),
                cleanupError: undefined,
                updatedAt: new Date().toISOString(),
              }
              if (task.worktreeProvider === 'treehouse' && task.leaseStatus === 'leased') {
                const leaseReturn = await returnTaskLease(recoveredTask)
                if (!leaseReturn.returned)
                  return errorResult(leaseReturn.error || 'Treehouse lease return failed; preserving durable state.', {
                    action: params.action,
                    taskId,
                    task: leaseReturn.task,
                    leaseReturned: false,
                    force: params.force,
                    discard: params.discard,
                  })
                recoveredTask = leaseReturn.task
              }
              await writeTaskState(recoveredTask)
              const artifactCleanup = await removeTaskArtifacts(taskId, true)
              if (!artifactCleanup.success) {
                const retainedTask = { ...recoveredTask, cleanupError: `artifact cleanup failed: ${JSON.stringify(artifactCleanup.errors)}`, updatedAt: new Date().toISOString() }
                await writeTaskState(retainedTask).catch(() => undefined)
                return errorResult('worker recovery completed only partially; durable state is retained for retry.', {
                  action: params.action,
                  taskId,
                  task: retainedTask,
                  artifactCleanup,
                  tabClosed: true,
                  leaseReturned: task.worktreeProvider === 'treehouse' ? recoveredTask.leaseStatus === 'returned' : undefined,
                })
              }
              const details = {
                action: params.action,
                taskId,
                task: recoveredTask,
                tabClosed: true,
                leaseReturned: task.worktreeProvider === 'treehouse' ? recoveredTask.leaseStatus === 'returned' : undefined,
                artifactsRemoved: artifactCleanup.removed,
                artifactsMissing: artifactCleanup.missing,
                force: params.force === true,
                discard: params.discard === true,
              }
              return { content: [{ type: 'text' as const, text: JSON.stringify(details, null, 2) }], details }
            }
            case 'task_teardown': {
              const taskIdError = validateTaskId(params.taskId)
              if (taskIdError) return errorResult(taskIdError, { action: params.action, taskId: params.taskId })
              const taskId = params.taskId!
              const task = await readTaskState(taskId)
              const taskPath = taskFilePath(taskId)
              const reportPath = reportFilePath(taskId)
              if (!task || task.version !== TASK_VERSION || task.taskId !== taskId) {
                return errorResult('durable task state is absent or malformed.', { action: params.action, taskId, taskPath })
              }
              if (task.reportPath !== reportPath) {
                return errorResult('durable task state has an unexpected report path.', { action: params.action, taskId, taskPath, expectedReportPath: reportPath, task })
              }
              if (
                task.status !== 'started' ||
                typeof task.worktree !== 'string' ||
                !task.worktree ||
                typeof task.workspaceId !== 'string' ||
                !WORKSPACE_ID_RE.test(task.workspaceId) ||
                typeof task.tabId !== 'string' ||
                !TAB_ID_RE.test(task.tabId) ||
                typeof task.paneId !== 'string' ||
                !PANE_ID_RE.test(task.paneId) ||
                typeof task.workerName !== 'string' ||
                !AGENT_NAME_RE.test(task.workerName) ||
                task.workerName === FIRSTMATE_NAME ||
                typeof task.workerKind !== 'string' ||
                !AGENT_KIND_RE.test(task.workerKind) ||
                (task.cleanupStatus !== undefined && task.cleanupStatus !== 'pending' && task.cleanupStatus !== 'closing' && task.cleanupStatus !== 'tab_closed') ||
                (task.worktreeProvider !== undefined && task.worktreeProvider !== 'herdr' && task.worktreeProvider !== 'treehouse') ||
                (task.worktreeProvider === 'treehouse' && task.leaseStatus !== 'leased' && task.leaseStatus !== 'retained' && task.leaseStatus !== 'returned')
              ) {
                return errorResult('durable task state is malformed or does not identify one exact worker endpoint.', { action: params.action, taskId, taskPath, task })
              }
              const reviewTask = typeof task.reviewTarget === 'string' && task.reviewTarget.length > 0
              if (
                task.worktreeProvider === 'treehouse' &&
                !reviewTask &&
                (!canCleanupAfterDelivery({
                  reportCompleted: task.reportStatus === 'completed' && task.reportOutcome === 'completed',
                  deliveryStatus: task.deliveryStatus,
                  leaseStatus: task.leaseStatus,
                }) ||
                  typeof (task.deliveryTargetBranch || task.deliveryDefaultBranch) !== 'string' ||
                  typeof task.deliveryCommit !== 'string' ||
                  typeof task.deliveryAt !== 'string')
              ) {
                return errorResult('task teardown requires successful explicit local delivery before cleanup.', { action: params.action, taskId, taskPath, task, delivered: false })
              }
              if (task.cleanupStatus === 'tab_closed') {
                const artifactCleanup = await removeTaskArtifacts(taskId, true)
                if (!artifactCleanup.success) {
                  const retainedTask = { ...task, cleanupError: `artifact cleanup failed: ${JSON.stringify(artifactCleanup.errors)}`, updatedAt: new Date().toISOString() }
                  await writeTaskState(retainedTask).catch(() => undefined)
                  return errorResult('terminal cleanup is incomplete; durable state is retained for retry.', {
                    action: params.action,
                    taskId,
                    task: retainedTask,
                    artifactsRemoved: artifactCleanup.removed,
                    artifactsMissing: artifactCleanup.missing,
                  })
                }
                const details = { action: params.action, taskId, task, tabClosed: true, idempotent: true, artifactsRemoved: artifactCleanup.removed, artifactsMissing: artifactCleanup.missing }
                return { content: [{ type: 'text' as const, text: JSON.stringify(details, null, 2) }], details }
              }
              if (task.reportStatus !== 'completed' || task.reportOutcome !== 'completed' || typeof task.reportUpdatedAt !== 'string' || typeof task.reportSummary !== 'string') {
                return errorResult('task teardown requires a reconciled completed worker report.', { action: params.action, taskId, taskPath, reportPath, reconciled: false, complete: false, task })
              }

              let reportText: string
              try {
                reportText = await fs.promises.readFile(reportPath, 'utf8')
              } catch (error) {
                return errorResult(`worker report is missing or unreadable: ${(error as Error).message}`, {
                  action: params.action,
                  taskId,
                  taskPath,
                  reportPath,
                  reconciled: false,
                  complete: false,
                  task,
                })
              }
              let parsedReport: unknown
              try {
                parsedReport = JSON.parse(reportText)
              } catch (error) {
                return errorResult(`worker report is malformed JSON: ${(error as Error).message}`, { action: params.action, taskId, taskPath, reportPath, reconciled: false, complete: false, task })
              }
              const validation = validateWorkerReport(parsedReport, taskId)
              if (!validation.report || validation.report.outcome !== 'completed') {
                return errorResult(`worker report is not a valid completed report: ${validation.error || `outcome is ${validation.report?.outcome}`}`, {
                  action: params.action,
                  taskId,
                  taskPath,
                  reportPath,
                  reconciled: false,
                  complete: false,
                  task,
                  report: parsedReport,
                })
              }
              if (task.reportSummary !== validation.report.summary) {
                return errorResult('durable task report summary does not match the reconciled report.', {
                  action: params.action,
                  taskId,
                  taskPath,
                  reportPath,
                  reconciled: false,
                  complete: false,
                  task,
                  report: validation.report,
                })
              }

              taskTeardownReport = validation.report
              const workspaceId = process.env.HERDR_WORKSPACE_ID
              if (!workspaceId || !WORKSPACE_ID_RE.test(workspaceId)) return errorResult('HERDR_WORKSPACE_ID is missing or invalid.', { action: params.action, taskId, task })
              if (typeof task.workspaceId !== 'string' || !WORKSPACE_ID_RE.test(task.workspaceId)) {
                return errorResult('durable task workspace id is invalid.', { action: params.action, taskId, task, currentWorkspaceId: workspaceId })
              }
              if (task.worktreeProvider === 'treehouse' && task.workspaceId !== workspaceId) {
                return errorResult('Treehouse-backed task is outside the current firstmate workspace.', { action: params.action, taskId, task, currentWorkspaceId: workspaceId })
              }
              const currentPaneId = process.env.HERDR_PANE_ID
              const currentPaneError = validatePaneId(currentPaneId, 'HERDR_PANE_ID')
              if (currentPaneError) return errorResult(currentPaneError, { action: params.action, taskId, task })
              const currentPaneResult = await runHerdr(['pane', 'get', currentPaneId!], signal, 10_000)
              const currentPanePayload = parseJsonMaybe(currentPaneResult.stdout) as { result?: { pane?: Record<string, unknown> } } | undefined
              const currentPane = currentPanePayload?.result?.pane
              if (
                currentPaneResult.code !== 0 ||
                !currentPane ||
                currentPane.pane_id !== currentPaneId ||
                currentPane.workspace_id !== workspaceId ||
                typeof currentPane.tab_id !== 'string' ||
                !TAB_ID_RE.test(currentPane.tab_id)
              ) {
                return errorResult('could not establish the exact current firstmate tab.', {
                  action: params.action,
                  taskId,
                  task,
                  currentPane: {
                    argv: ['herdr', 'pane', 'get', currentPaneId!],
                    exitCode: currentPaneResult.code,
                    stdout: currentPaneResult.stdout,
                    stderr: currentPaneResult.stderr,
                    parsed: parseJsonMaybe(currentPaneResult.stdout),
                  },
                })
              }
              if (currentPane.tab_id === task.tabId) {
                return errorResult('refusing to close the current firstmate tab.', { action: params.action, taskId, task, currentTabId: currentPane.tab_id })
              }
              if (task.cleanupStatus === 'tab_closed') {
                const details = {
                  action: params.action,
                  taskId,
                  taskPath,
                  reportPath,
                  reconciled: true,
                  complete: true,
                  idempotent: true,
                  tabClosed: true,
                  worktreePreserved: true,
                  leaseReturned: task.worktreeProvider === 'treehouse' ? task.leaseStatus === 'returned' && task.leaseReturnStatus === 'returned' : undefined,
                  leaseNotRequired: task.worktreeProvider === 'herdr',
                  task,
                  report: validation.report,
                }
                return { content: [{ type: 'text' as const, text: JSON.stringify(details, null, 2) }], details }
              }

              taskTeardownRecord = task
              params.tabId = task.tabId
              // Fall through to the existing exact tab_close inspection and command.
            }
            case 'tab_close': {
              const tabIdError = validateTabId(params.tabId)
              if (tabIdError) return errorResult(tabIdError, { action: params.action, tabId: params.tabId })

              const workspaceId = process.env.HERDR_WORKSPACE_ID
              if (!workspaceId || !WORKSPACE_ID_RE.test(workspaceId)) {
                return errorResult('HERDR_WORKSPACE_ID is missing or invalid.', { action: params.action, tabId: params.tabId })
              }
              const targetWorkspaceId = taskTeardownRecord?.workspaceId ?? workspaceId
              const currentPaneId = process.env.HERDR_PANE_ID
              const currentPaneError = validatePaneId(currentPaneId, 'HERDR_PANE_ID')
              if (currentPaneError) return errorResult(currentPaneError, { action: params.action, tabId: params.tabId })

              const currentPaneResult = await runHerdr(['pane', 'get', currentPaneId!], signal, 10_000)
              const currentPanePayload = parseJsonMaybe(currentPaneResult.stdout) as { result?: { pane?: Record<string, unknown> } } | undefined
              const currentPane = currentPanePayload?.result?.pane
              const currentPaneInspection = {
                argv: ['herdr', 'pane', 'get', currentPaneId!],
                exitCode: currentPaneResult.code,
                stdout: currentPaneResult.stdout,
                stderr: currentPaneResult.stderr,
                parsed: parseJsonMaybe(currentPaneResult.stdout),
              }
              if (currentPaneResult.code !== 0 || !currentPane) {
                return errorResult('could not inspect the current firstmate pane.', { action: params.action, tabId: params.tabId, currentPane: currentPaneInspection })
              }
              if (currentPane.pane_id !== currentPaneId || currentPane.workspace_id !== workspaceId || typeof currentPane.tab_id !== 'string' || !TAB_ID_RE.test(currentPane.tab_id)) {
                return errorResult('could not establish the exact current firstmate tab.', { action: params.action, tabId: params.tabId, currentPane: currentPaneInspection })
              }
              if (currentPane.tab_id === params.tabId) {
                return errorResult('refusing to close the current firstmate tab.', { action: params.action, tabId: params.tabId, currentTabId: currentPane.tab_id, currentPane: currentPaneInspection })
              }

              const targetTabResult = await runHerdr(['tab', 'get', params.tabId!], signal, 10_000)
              const targetTabPayload = parseJsonMaybe(targetTabResult.stdout) as { result?: { tab?: Record<string, unknown> } } | undefined
              const targetTab = targetTabPayload?.result?.tab
              const targetTabInspection = {
                argv: ['herdr', 'tab', 'get', params.tabId!],
                exitCode: targetTabResult.code,
                stdout: targetTabResult.stdout,
                stderr: targetTabResult.stderr,
                parsed: parseJsonMaybe(targetTabResult.stdout),
              }
              if (targetTabResult.code !== 0 || !targetTab) {
                const treehouseRecoveryEligible =
                  taskTeardownRecord?.worktreeProvider === 'treehouse' && taskTeardownRecord.leaseStatus === 'leased' && taskTeardownRecord.workspaceId === targetWorkspaceId
                const sharedRecoveryEligible = taskTeardownRecord?.worktreeProvider === 'herdr' && taskTeardownRecord.workspaceId === targetWorkspaceId
                const recoveryEligible = treehouseRecoveryEligible || sharedRecoveryEligible
                if (
                  recoveryEligible &&
                  taskTeardownRecord &&
                  taskTeardownRecord.tabId === params.tabId &&
                  typeof taskTeardownRecord.paneId === 'string' &&
                  PANE_ID_RE.test(taskTeardownRecord.paneId)
                ) {
                  const [tabListResult, paneListResult] = await Promise.all([
                    runHerdr(['tab', 'list', '--workspace', targetWorkspaceId], signal, 10_000),
                    runHerdr(['pane', 'list', '--workspace', targetWorkspaceId], signal, 10_000),
                  ])
                  const tabListPayload = parseJsonMaybe(tabListResult.stdout) as { result?: { tabs?: unknown } } | undefined
                  const paneListPayload = parseJsonMaybe(paneListResult.stdout) as { result?: { panes?: unknown } } | undefined
                  const tabEntriesValue = tabListPayload?.result?.tabs
                  const paneEntriesValue = paneListPayload?.result?.panes
                  const tabEntries = Array.isArray(tabEntriesValue) && tabEntriesValue.every((entry) => isRecord(entry)) ? (tabEntriesValue as Array<Record<string, unknown>>) : undefined
                  const paneEntries = Array.isArray(paneEntriesValue) && paneEntriesValue.every((entry) => isRecord(entry)) ? (paneEntriesValue as Array<Record<string, unknown>>) : undefined
                  const recordedTabAbsent = tabListResult.code === 0 && !!tabEntries && !tabEntries.some((entry) => entry.tab_id === params.tabId)
                  const recordedPaneAbsent = paneListResult.code === 0 && !!paneEntries && !paneEntries.some((entry) => entry.pane_id === taskTeardownRecord!.paneId)
                  const recoveryInspection = {
                    marker: TREEHOUSE_RETURN_SUCCESS_MARKER,
                    tab: {
                      argv: ['herdr', 'tab', 'list', '--workspace', targetWorkspaceId],
                      exitCode: tabListResult.code,
                      stdout: tabListResult.stdout,
                      stderr: tabListResult.stderr,
                      parsed: tabListPayload,
                    },
                    pane: {
                      argv: ['herdr', 'pane', 'list', '--workspace', targetWorkspaceId],
                      exitCode: paneListResult.code,
                      stdout: paneListResult.stdout,
                      stderr: paneListResult.stderr,
                      parsed: paneListPayload,
                    },
                    recordedTabAbsent,
                    recordedPaneAbsent,
                  }
                  if (recordedTabAbsent && recordedPaneAbsent) {
                    const recoveredTask: TaskRecord = treehouseRecoveryEligible
                      ? {
                          ...taskTeardownRecord,
                          endpointStatus: 'absent_verified',
                          leaseStatus: 'returned',
                          leaseReturnStatus: 'returned',
                          leaseReturnError: undefined,
                          updatedAt: new Date().toISOString(),
                        }
                      : { ...taskTeardownRecord, endpointStatus: 'absent_verified', updatedAt: new Date().toISOString() }
                    try {
                      await writeTaskState(recoveredTask)
                    } catch (error) {
                      return errorResult(`could not persist recovered absent-worker state: ${(error as Error).message}`, {
                        action: params.action,
                        taskId: recoveredTask.taskId,
                        task: recoveredTask,
                        recovery: recoveryInspection,
                      })
                    }
                    taskTeardownRecord = recoveredTask
                    taskTeardownTabAlreadyAbsent = true
                    tabCloseInspection = { currentPane: currentPaneInspection, tab: targetTabInspection, recovery: recoveryInspection }
                    break
                  }
                }
                return errorResult('target tab is absent or could not be inspected.', { action: params.action, tabId: params.tabId, currentPane: currentPaneInspection, tab: targetTabInspection })
              }
              if (targetTab.tab_id !== params.tabId || targetTab.workspace_id !== targetWorkspaceId) {
                return errorResult('target tab is ambiguous or outside the firstmate workspace.', {
                  action: params.action,
                  tabId: params.tabId,
                  currentPane: currentPaneInspection,
                  tab: targetTabInspection,
                })
              }

              const paneListResult = await runHerdr(['pane', 'list', '--workspace', targetWorkspaceId], signal, 10_000)
              const paneListPayload = parseJsonMaybe(paneListResult.stdout) as { result?: { panes?: Array<Record<string, unknown>> } } | undefined
              const panes = paneListPayload?.result?.panes
              const paneListInspection = {
                argv: ['herdr', 'pane', 'list', '--workspace', targetWorkspaceId],
                exitCode: paneListResult.code,
                stdout: paneListResult.stdout,
                stderr: paneListResult.stderr,
                parsed: parseJsonMaybe(paneListResult.stdout),
              }
              if (paneListResult.code !== 0 || !panes) {
                return errorResult("could not inspect the target tab's panes.", {
                  action: params.action,
                  tabId: params.tabId,
                  currentPane: currentPaneInspection,
                  tab: targetTabInspection,
                  panes: paneListInspection,
                })
              }
              const targetPanes = panes.filter((pane) => pane.tab_id === params.tabId)
              if (targetTab.pane_count !== 1 || targetPanes.length !== 1) {
                return errorResult(
                  targetPanes.length > 1 || targetTab.pane_count !== 1 ? 'refusing to close a tab with multiple panes or an ambiguous pane layout.' : 'target tab is absent; it has no exact pane.',
                  { action: params.action, tabId: params.tabId, currentPane: currentPaneInspection, tab: targetTabInspection, panes: paneListInspection, matchingPaneCount: targetPanes.length },
                )
              }

              const targetPaneId = targetPanes[0].pane_id
              if (typeof targetPaneId !== 'string' || !PANE_ID_RE.test(targetPaneId)) {
                return errorResult('target tab has an absent or malformed pane id.', {
                  action: params.action,
                  tabId: params.tabId,
                  currentPane: currentPaneInspection,
                  tab: targetTabInspection,
                  panes: paneListInspection,
                  targetPane: targetPanes[0],
                })
              }
              const targetPaneResult = await runHerdr(['pane', 'get', targetPaneId], signal, 10_000)
              const targetPanePayload = parseJsonMaybe(targetPaneResult.stdout) as { result?: { pane?: Record<string, unknown> } } | undefined
              const targetPane = targetPanePayload?.result?.pane
              const targetPaneInspection = {
                argv: ['herdr', 'pane', 'get', targetPaneId],
                exitCode: targetPaneResult.code,
                stdout: targetPaneResult.stdout,
                stderr: targetPaneResult.stderr,
                parsed: parseJsonMaybe(targetPaneResult.stdout),
              }
              if (targetPaneResult.code !== 0 || !targetPane || targetPane.pane_id !== targetPaneId || targetPane.tab_id !== params.tabId || targetPane.workspace_id !== targetWorkspaceId) {
                return errorResult('target pane is absent, ambiguous, or does not belong exactly to the target tab.', {
                  action: params.action,
                  tabId: params.tabId,
                  currentPane: currentPaneInspection,
                  tab: targetTabInspection,
                  panes: paneListInspection,
                  pane: targetPaneInspection,
                })
              }

              const agentResult = await runHerdr(['agent', 'get', targetPaneId], signal, 10_000)
              const agentPayload = parseJsonMaybe(agentResult.stdout) as { result?: { agent?: Record<string, unknown> } } | undefined
              const agent = agentPayload?.result?.agent
              const agentInspection = {
                argv: ['herdr', 'agent', 'get', targetPaneId],
                exitCode: agentResult.code,
                stdout: agentResult.stdout,
                stderr: agentResult.stderr,
                parsed: parseJsonMaybe(agentResult.stdout),
              }
              if (
                agentResult.code !== 0 ||
                !agent ||
                agent.pane_id !== targetPaneId ||
                agent.tab_id !== params.tabId ||
                agent.workspace_id !== targetWorkspaceId ||
                typeof agent.name !== 'string' ||
                !AGENT_NAME_RE.test(agent.name) ||
                agent.name === FIRSTMATE_NAME
              ) {
                return errorResult('target pane has no exact registered worker agent.', {
                  action: params.action,
                  tabId: params.tabId,
                  currentPane: currentPaneInspection,
                  tab: targetTabInspection,
                  panes: paneListInspection,
                  pane: targetPaneInspection,
                  agent: agentInspection,
                })
              }

              const statuses = {
                tab: typeof targetTab.agent_status === 'string' ? targetTab.agent_status : 'unknown',
                pane: typeof targetPane.agent_status === 'string' ? targetPane.agent_status : 'unknown',
                agent: typeof agent.agent_status === 'string' ? agent.agent_status : 'unknown',
              }
              tabCloseTargetPaneId = targetPaneId
              tabCloseAgentName = typeof agent.name === 'string' ? agent.name : undefined
              tabCloseAgentKind = typeof agent.agent === 'string' ? agent.agent : undefined
              const refusedStatus = Object.entries(statuses).find(([, status]) => status !== 'idle' && status !== 'done')
              tabCloseInspection = { currentPane: currentPaneInspection, tab: targetTabInspection, panes: paneListInspection, pane: targetPaneInspection, agent: agentInspection, statuses }
              if (refusedStatus) {
                return errorResult(`refusing to close target tab: ${refusedStatus[0]} agent status is ${refusedStatus[1]}.`, {
                  action: params.action,
                  tabId: params.tabId,
                  currentPane: currentPaneInspection,
                  ...tabCloseInspection,
                })
              }

              const sameWorkspace = taskTeardownRecord?.workspaceId === workspaceId
              if (taskTeardownRecord && !sameWorkspace) {
                const workspaceListResult = await runHerdr(['workspace', 'list'], signal, 10_000)
                const workspaceListPayload = parseJsonMaybe(workspaceListResult.stdout) as { result?: { workspaces?: unknown } } | undefined
                const workspaceEntriesValue = workspaceListPayload?.result?.workspaces
                const workspaceEntries = Array.isArray(workspaceEntriesValue) ? (workspaceEntriesValue as Array<Record<string, unknown>>) : undefined
                const workspaceListMalformed = !workspaceEntries || workspaceEntries.some((entry) => !isRecord(entry))
                const matchingWorkspaces = workspaceEntries?.filter((entry) => isRecord(entry) && entry.workspace_id === taskTeardownRecord!.workspaceId) ?? []
                const targetWorkspace = matchingWorkspaces.length === 1 ? matchingWorkspaces[0] : undefined
                const workspaceInspection = {
                  argv: ['herdr', 'workspace', 'list'],
                  exitCode: workspaceListResult.code,
                  stdout: workspaceListResult.stdout,
                  stderr: workspaceListResult.stderr,
                  parsed: parseJsonMaybe(workspaceListResult.stdout),
                }
                if (workspaceListResult.code !== 0 || workspaceListMalformed || !targetWorkspace || targetWorkspace.tab_count !== 1 || targetWorkspace.active_tab_id !== params.tabId) {
                  return errorResult('target workspace is absent, malformed, ambiguous, or does not contain exactly the durable task tab.', {
                    action: params.action,
                    taskId: taskTeardownRecord.taskId,
                    task: taskTeardownRecord,
                    workspace: workspaceInspection,
                    expectedWorkspaceId: taskTeardownRecord.workspaceId,
                    expectedTabId: params.tabId,
                  })
                }
                args = ['workspace', 'close', targetWorkspaceId]
              } else {
                args = ['tab', 'close', params.tabId!]
              }
              break
            }
          }

          if (taskTeardownRecord) {
            if (
              !taskTeardownTabAlreadyAbsent &&
              (tabCloseTargetPaneId !== taskTeardownRecord.paneId || tabCloseAgentName !== taskTeardownRecord.workerName || tabCloseAgentKind !== taskTeardownRecord.workerKind)
            ) {
              return errorResult('live worker endpoint does not match the durable task identity.', {
                action: params.action,
                taskId: taskTeardownRecord.taskId,
                task: taskTeardownRecord,
                inspection: tabCloseInspection,
              })
            }
            const closingTask: TaskRecord = {
              ...taskTeardownRecord,
              cleanupStatus: 'closing',
              cleanupUpdatedAt: new Date().toISOString(),
              cleanupError: undefined,
              updatedAt: new Date().toISOString(),
            }
            try {
              await writeTaskState(closingTask)
            } catch (error) {
              return errorResult(`could not persist task teardown state before closing the tab: ${(error as Error).message}`, {
                action: params.action,
                taskId: closingTask.taskId,
                taskPath: taskFilePath(closingTask.taskId),
                task: closingTask,
                tabClosed: false,
                inspection: tabCloseInspection,
              })
            }
            taskTeardownRecord = closingTask
            if (taskTeardownTabAlreadyAbsent) {
              const leaseReturn = await returnTaskLease(closingTask)
              if (!leaseReturn.returned) {
                const retainedTask = {
                  ...leaseReturn.task,
                  cleanupStatus: 'closing' as const,
                  cleanupError: leaseReturn.error || 'Treehouse lease return failed after verified worker absence.',
                  updatedAt: new Date().toISOString(),
                }
                await writeTaskState(retainedTask).catch(() => undefined)
                return errorResult(retainedTask.cleanupError || 'Treehouse lease return failed; preserving durable state.', {
                  action: params.action,
                  taskId: retainedTask.taskId,
                  task: retainedTask,
                  leaseReturned: false,
                  tabClosed: true,
                  inspection: tabCloseInspection,
                  leaseReturn: leaseReturn.result,
                })
              }
              taskTeardownRecord = leaseReturn.task
              const returnedClosingTask = { ...leaseReturn.task, cleanupStatus: 'closing' as const, cleanupUpdatedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
              await writeTaskState(returnedClosingTask)
              taskTeardownRecord = returnedClosingTask

              const closedTask: TaskRecord = {
                ...taskTeardownRecord,
                cleanupStatus: 'tab_closed',
                cleanupUpdatedAt: new Date().toISOString(),
                cleanupError: undefined,
                updatedAt: new Date().toISOString(),
              }
              try {
                await writeTaskState(closedTask)
              } catch (error) {
                return errorResult(`worker tab is already absent but durable tab-closed status could not be persisted: ${(error as Error).message}`, {
                  action: params.action,
                  taskId: closedTask.taskId,
                  taskPath: taskFilePath(closedTask.taskId),
                  task: closedTask,
                  tabClosed: true,
                  cleanupRecorded: false,
                  inspection: tabCloseInspection,
                })
              }
              const artifactCleanup = await removeTaskArtifacts(closedTask.taskId, true)
              if (!artifactCleanup.success) {
                const retainedTask = { ...closedTask, cleanupError: `artifact cleanup failed: ${JSON.stringify(artifactCleanup.errors)}`, updatedAt: new Date().toISOString() }
                await writeTaskState(retainedTask).catch(() => undefined)
                return errorResult('worker tab was absent and lease was handled, but artifact cleanup is incomplete; durable state is retained.', {
                  action: params.action,
                  taskId: closedTask.taskId,
                  task: retainedTask,
                  tabClosed: true,
                  leaseReturned: true,
                  artifactCleanup,
                  inspection: tabCloseInspection,
                })
              }
              const teardownDetails = {
                action: params.action,
                taskId: closedTask.taskId,
                taskPath: taskFilePath(closedTask.taskId),
                reportPath: reportFilePath(closedTask.taskId),
                reconciled: true,
                complete: true,
                idempotent: false,
                tabClosed: true,
                cleanupRecorded: true,
                workerTabAbsent: true,
                worktreePreserved: true,
                leaseReturned: true,
                artifactsRemoved: artifactCleanup.removed,
                artifactsMissing: artifactCleanup.missing,
                task: closedTask,
                report: taskTeardownReport,
                inspection: tabCloseInspection,
              }
              return { content: [{ type: 'text' as const, text: JSON.stringify(teardownDetails, null, 2) }], details: teardownDetails }
            }
          }

          const result = await runHerdr(args, signal, timeout)
          const parsed = parseJsonMaybe(result.stdout)
          const details = {
            action: params.action,
            argv: ['herdr', ...args],
            exitCode: result.code,
            killed: result.killed,
            stdout: result.stdout,
            stderr: result.stderr,
            parsed,
            ...(tabCloseInspection ? { inspection: tabCloseInspection } : {}),
          }
          if (taskTeardownRecord) {
            if (result.code !== 0) {
              const retryTask: TaskRecord = {
                ...taskTeardownRecord,
                cleanupStatus: 'pending',
                cleanupUpdatedAt: new Date().toISOString(),
                cleanupError: commandResultText(`herdr ${args.join(' ')}`, result),
                updatedAt: new Date().toISOString(),
              }
              await writeTaskState(retryTask).catch(() => undefined)
              return errorResult(commandResultText(`herdr ${args.join(' ')}`, result), { ...details, task: retryTask, tabClosed: false })
            }
            const [verifyTabs, verifyPanes] = await Promise.all([
              runHerdr(['tab', 'list', '--workspace', taskTeardownRecord.workspaceId!], signal, 10_000),
              runHerdr(['pane', 'list', '--workspace', taskTeardownRecord.workspaceId!], signal, 10_000),
            ])
            const verifiedTabs = (parseJsonMaybe(verifyTabs.stdout) as { result?: { tabs?: unknown } } | undefined)?.result?.tabs
            const verifiedPanes = (parseJsonMaybe(verifyPanes.stdout) as { result?: { panes?: unknown } } | undefined)?.result?.panes
            const endpointAbsent = endpointListsConfirmAbsence({
              tabListSucceeded: verifyTabs.code === 0,
              paneListSucceeded: verifyPanes.code === 0,
              tabs: verifiedTabs,
              panes: verifiedPanes,
              tabId: taskTeardownRecord.tabId!,
              paneId: taskTeardownRecord.paneId!,
            })
            if (!endpointAbsent) {
              const retainedTask: TaskRecord = {
                ...taskTeardownRecord,
                cleanupStatus: 'closing',
                cleanupError: 'worker tab close was acknowledged but recorded tab/pane absence was not verified.',
                updatedAt: new Date().toISOString(),
              }
              await writeTaskState(retainedTask).catch(() => undefined)
              return errorResult('worker tab close was acknowledged, but recorded worker tab and pane absence was not verified; preserving durable state and lease.', {
                ...details,
                task: retainedTask,
                tabClosed: false,
                endpointVerification: { tabs: verifyTabs, panes: verifyPanes },
              })
            }
            const leaseReturn = await returnTaskLease({ ...taskTeardownRecord, endpointStatus: 'absent_verified' })
            if (!leaseReturn.returned) {
              const retainedTask = {
                ...leaseReturn.task,
                cleanupStatus: 'closing' as const,
                cleanupError: leaseReturn.error || 'Treehouse lease return failed after worker tab close.',
                updatedAt: new Date().toISOString(),
              }
              await writeTaskState(retainedTask).catch(() => undefined)
              return errorResult(retainedTask.cleanupError || 'Treehouse lease return failed; preserving durable state.', {
                ...details,
                task: retainedTask,
                tabClosed: true,
                leaseReturned: false,
                leaseReturn: leaseReturn.result,
              })
            }
            taskTeardownRecord = leaseReturn.task
            const closedTask: TaskRecord = {
              ...taskTeardownRecord,
              cleanupStatus: 'tab_closed',
              leaseStatus: taskTeardownRecord.worktreeProvider === 'treehouse' ? 'returned' : taskTeardownRecord.leaseStatus,
              cleanupUpdatedAt: new Date().toISOString(),
              cleanupError: undefined,
              updatedAt: new Date().toISOString(),
            }
            try {
              await writeTaskState(closedTask)
            } catch (error) {
              return errorResult(`tab closed but durable tab-closed status could not be persisted: ${(error as Error).message}`, {
                ...details,
                task: closedTask,
                tabClosed: true,
                cleanupRecorded: false,
                worktreePreserved: true,
              })
            }
            const artifactCleanup = await removeTaskArtifacts(closedTask.taskId, true)
            if (!artifactCleanup.success) {
              const retainedTask = { ...closedTask, cleanupError: `artifact cleanup failed: ${JSON.stringify(artifactCleanup.errors)}`, updatedAt: new Date().toISOString() }
              await writeTaskState(retainedTask).catch(() => undefined)
              return errorResult('worker tab and lease cleanup succeeded, but artifact cleanup is incomplete; durable state is retained.', {
                ...details,
                task: retainedTask,
                tabClosed: true,
                leaseReturned: true,
                artifactCleanup,
              })
            }
            const teardownDetails = {
              ...details,
              task: closedTask,
              tabClosed: true,
              cleanupRecorded: true,
              idempotent: false,
              worktreePreserved: true,
              leaseReturned: closedTask.worktreeProvider === 'treehouse' ? closedTask.leaseStatus === 'returned' : undefined,
              leaseNotRequired: closedTask.worktreeProvider === 'herdr',
              artifactsRemoved: artifactCleanup.removed,
              artifactsMissing: artifactCleanup.missing,
            }
            return { content: [{ type: 'text' as const, text: JSON.stringify(teardownDetails, null, 2) }], details: teardownDetails }
          }
          if (result.code !== 0) return errorResult(commandResultText(`herdr ${args.join(' ')}`, result), details)
          return {
            content: [{ type: 'text' as const, text: parsed ? JSON.stringify(parsed, null, 2) : commandResultText(`herdr ${args.join(' ')}`, result) }],
            details,
          }
        } finally {
          try {
            await releaseSharedAdmission?.()
          } finally {
            releaseLifecycle?.()
          }
        }
      },
    })
  }

  pi.on('session_start', async (_event, ctx) => {
    if (active || !isInteractivePiPane(ctx)) return
    try {
      const isPaneLive = async (paneId: string) => {
        const result = await runHerdr(['agent', 'get', paneId], undefined, 5_000)
        return result.code === 0
      }
      active = await acquireFirstmateMarker(isPaneLive)
    } catch (error) {
      ctx.ui.notify(`Firstmate marker error: ${(error as Error).message}`, 'warning')
      active = false
    }
    if (!active) {
      delete process.env[ACTIVE_ENV]
      return
    }
    process.env[ACTIVE_ENV] = '1'

    const toolsExpanded = ctx.ui.getToolsExpanded()
    ctx.ui.setToolsExpanded(false)
    restoreToolsExpanded = () => ctx.ui.setToolsExpanded(toolsExpanded)

    restoreIsolationMode(ctx)
    restoreWorkerKind(ctx)
    registerIsolationCommand()
    registerWorkerCommand()
    registerFirstmateTool()
    registerTurnEndGuard()
    applyFirstmateTools()
    startWatcher()
    pi.setSessionName(FIRSTMATE_NAME)
    ctx.ui.setTitle(FIRSTMATE_NAME)
    void (async () => {
      for (const delay of [0, 500, 1500, 3000, 6000]) {
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
        await renameHerdrAgent()
        await deriveCurrentAgentKind().catch(() => undefined)
      }
    })()
  })

  pi.on('session_shutdown', async () => {
    delete process.env[ACTIVE_ENV]
    stopWatcher()
    restoreToolsExpanded?.()
    restoreToolsExpanded = undefined
  })

  pi.on('resources_discover', () => {
    if (active) applyFirstmateTools()
  })

  pi.on('before_agent_start', (event) => {
    if (!active) return
    applyFirstmateTools()
    const kindLine = `\n\nCurrent firstmate agent kind: ${currentAgentKind || 'unknown'}. Current selected worker kind: ${selectedWorkerKind}; task_create uses this by default. Select the allowlisted worker kind with /firstmate-worker pi or /firstmate-worker claude.`
    const isolationLine = `\n\nCurrent session isolation mode: ${isolationMode}. task_create must use ${isolationMode === 'shared' ? 'the requested shared checkout; do not start concurrent shared tasks for that project' : 'an isolated Treehouse worktree and require task_deliver before teardown'}. The captain can switch it with /firstmate-isolation shared or /firstmate-isolation worktree.`
    return { systemPrompt: `${FIRSTMATE_SYSTEM_PROMPT}${kindLine}${isolationLine}\n\n${event.systemPrompt}` }
  })

  pi.on('tool_call', (event) => {
    if (!active) return
    if (!isFirstmateAllowedTool(event.toolName)) {
      return {
        block: true,
        terminate: true,
        reason:
          'Firstmate is coordination-only: direct file mutation and shell tools are blocked. All implementation and code mutations must use herdr_control.task_create and visible worker tabs. Only read, grep, find, ls, the browser-tester-only subagent exception, herdr_control, and artifact are allowed; artifact is limited to generated browser artifacts, reports, or diagrams under the project .pi/artifacts/ directory.'
      }
    }
    if (event.toolName === 'subagent' && !isAllowedFirstmateSubagentRequest(event.input)) {
      return {
        block: true,
        terminate: true,
        reason: 'Firstmate may use subagent only for browser QA through the user-scoped browser-tester agent; all implementation and reconnaissance must use herdr_control.task_create and visible worker tabs.',
      }
    }
  })
}
