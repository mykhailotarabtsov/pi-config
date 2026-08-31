import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import test from 'node:test'
import { FIRSTMATE_ALLOWED_TOOLS, FIRSTMATE_CONTROL_ACTIONS, isFirstmateAllowedTool, isFirstmateControlAction } from '../extensions/firstmate/control.ts'
import { assessLocalDelivery, canCleanupAfterDelivery } from '../extensions/firstmate/delivery.ts'
import { validateWorkerReport, REPORT_VERSION } from '../extensions/firstmate/worker-report.ts'
import {
  appendUntilArgs,
  canDeleteWithoutRecordedEndpoint,
  isAllowedFirstmateSubagentRequest,
  canMarkLeaseReturned,
  endpointListsConfirmAbsence,
  hasExactWorkerIdentity,
  isPendingLeaseNoop,
  LifecycleOperationLock,
  normalizeUntil,
  taskArtifactNames,
} from '../extensions/firstmate/lifecycle.ts'
import { readFile } from 'node:fs/promises'

const execFileAsync = promisify(execFile)
const fastForward = { targetBranch: 'feature/current', dirtyPathCheckSucceeded: true, dirtyPathsOverlap: false, branchExists: true, fastForward: true }

test('pending Treehouse leases are an idempotent no-op', () => {
  assert.equal(isPendingLeaseNoop('pending'), true)
  assert.equal(isPendingLeaseNoop('leased'), false)
})

test('Treehouse lease return requires command, temp cleanup, and helper-close verification', () => {
  assert.equal(canMarkLeaseReturned({ commandSucceeded: true, tempCleanupSucceeded: true, helperClosed: true }), true)
  assert.equal(canMarkLeaseReturned({ commandSucceeded: true, tempCleanupSucceeded: false, helperClosed: true }), false)
  assert.equal(canMarkLeaseReturned({ commandSucceeded: true, tempCleanupSucceeded: true, helperClosed: false }), false)
})

test('endpoint cleanup guards distinguish verified absence from inspection failure', () => {
  assert.equal(canDeleteWithoutRecordedEndpoint('not_created'), false)
  assert.equal(canDeleteWithoutRecordedEndpoint('absent_verified'), true)
  assert.equal(canDeleteWithoutRecordedEndpoint('unverified'), false)
  assert.equal(canDeleteWithoutRecordedEndpoint(undefined), false)
  const absent = { tabs: [], panes: [], tabListSucceeded: true, paneListSucceeded: true, tabId: 'w1:t2', paneId: 'w1:p2' }
  assert.equal(endpointListsConfirmAbsence(absent), true)
  assert.equal(endpointListsConfirmAbsence({ ...absent, tabListSucceeded: false }), false)
  assert.equal(endpointListsConfirmAbsence({ ...absent, panes: [{ pane_id: 'w1:p2' }] }), false)
})

test('worker identity guard requires the recorded pane, tab, workspace, name, and kind', () => {
  const recorded = { workspaceId: 'w1', tabId: 'w1:t2', paneId: 'w1:p2', workerName: 'worker-one', workerKind: 'pi' }
  const observed = { workspace_id: 'w1', tab_id: 'w1:t2', pane_id: 'w1:p2', name: 'worker-one', agent: 'pi' }
  assert.equal(hasExactWorkerIdentity(recorded, observed), true)
  assert.equal(hasExactWorkerIdentity(recorded, { ...observed, agent: 'claude' }), false)
  assert.equal(hasExactWorkerIdentity(recorded, undefined), false)
})

test('lifecycle operations serialize and release idempotently', async () => {
  const lock = new LifecycleOperationLock()
  const releaseFirst = await lock.acquire()
  let secondAcquired = false
  const second = lock.acquire().then((release) => {
    secondAcquired = true
    release()
  })
  await Promise.resolve()
  assert.equal(secondAcquired, false)
  releaseFirst()
  await second
  assert.equal(secondAcquired, true)
  releaseFirst()
})

test('shared-admission cleanup failures cannot strand the lifecycle lock', async () => {
  const source = await readFile(new URL('../extensions/firstmate/index.ts', import.meta.url), 'utf8')
  assert.match(source, /finally \{\s+try \{\s+await releaseSharedAdmission\?\.\(\)\s+\} finally \{\s+releaseLifecycle\?\.\(\)\s+\}\s+\}/)

  const lock = new LifecycleOperationLock()
  const releaseLifecycle = await lock.acquire()
  let nextAcquired = false
  const next = lock.acquire().then((release) => {
    nextAcquired = true
    release()
  })
  await assert.rejects(
    (async () => {
      try {
        await Promise.reject(new Error('simulated admission cleanup failure'))
      } finally {
        releaseLifecycle()
      }
    })(),
    /simulated admission cleanup failure/,
  )
  await next
  assert.equal(nextAcquired, true)
})

test('until accepts legacy scalars and emits the exact repeated Herdr argument list', () => {
  assert.deepEqual(normalizeUntil('blocked'), ['blocked'])
  assert.deepEqual(normalizeUntil(['idle', 'done']), ['idle', 'done'])
  const args = ['agent', 'wait', 'worker']
  appendUntilArgs(args, 'blocked')
  appendUntilArgs(args, ['idle', 'done'])
  assert.deepEqual(args, ['agent', 'wait', 'worker', '--until', 'blocked', '--until', 'idle', '--until', 'done'])
})

test('task artifacts are an exact bounded per-task list', () => {
  assert.deepEqual(taskArtifactNames('task-x-12345678-123'), [
    'task-x-12345678-123.report.json',
    '.task-x-12345678-123.lease.json',
    '.task-x-12345678-123.lease.stderr',
    '.task-x-12345678-123.lease.status',
    '.task-x-12345678-123.lease-return.stdout',
    '.task-x-12345678-123.lease-return.stderr',
    '.task-x-12345678-123.lease-return.status',
    '.task-x-12345678-123.delivery.evidence',
    '.task-x-12345678-123.delivery.dirty-paths',
    '.task-x-12345678-123.delivery.worker-paths',
    '.task-x-12345678-123.delivery.stdout',
    '.task-x-12345678-123.delivery.stderr',
    '.task-x-12345678-123.delivery.status',
    '.task-x-12345678-123.delivery.sh',
  ])
})

test('delivery allows unrelated dirty paths on the current feature branch', () => {
  assert.deepEqual(assessLocalDelivery(fastForward), { allowed: true })
})

test('delivery rejects an overlapping tracked modification', () => {
  assert.deepEqual(assessLocalDelivery({ ...fastForward, dirtyPathsOverlap: true }), { allowed: false, reason: 'dirty-overlap' })
})

test('delivery rejects an incomplete dirty-path check', () => {
  assert.deepEqual(assessLocalDelivery({ ...fastForward, dirtyPathCheckSucceeded: false }), { allowed: false, reason: 'dirty-path-check-failed' })
})

test('delivery rejects an overlapping untracked path', () => {
  assert.deepEqual(assessLocalDelivery({ ...fastForward, dirtyPathsOverlap: true }), { allowed: false, reason: 'dirty-overlap' })
})

test('delivery refuses detached, missing branch, and diverged primary state', () => {
  assert.deepEqual(assessLocalDelivery({ ...fastForward, targetBranch: '' }), { allowed: false, reason: 'detached' })
  assert.deepEqual(assessLocalDelivery({ ...fastForward, branchExists: false }), { allowed: false, reason: 'missing-branch' })
  assert.deepEqual(assessLocalDelivery({ ...fastForward, fastForward: false }), { allowed: false, reason: 'diverged' })
})

test('delivery permits a feature-branch fast-forward and cleanup only after landing', () => {
  assert.deepEqual(assessLocalDelivery(fastForward), { allowed: true })
  assert.equal(canCleanupAfterDelivery({ reportCompleted: true, deliveryStatus: 'failed', leaseStatus: 'leased' }), false)
  assert.equal(canCleanupAfterDelivery({ reportCompleted: false, deliveryStatus: 'landed', leaseStatus: 'leased' }), false)
  assert.equal(canCleanupAfterDelivery({ reportCompleted: true, deliveryStatus: 'landed', leaseStatus: 'leased' }), true)
  assert.equal(canCleanupAfterDelivery({ reportCompleted: true, deliveryStatus: 'landed', leaseStatus: 'returned' }), true)
})

test('Firstmate exposes only high-level task actions and non-mutating tools', () => {
  assert.deepEqual(FIRSTMATE_CONTROL_ACTIONS, ['status', 'task_create', 'task_reconcile', 'task_deliver', 'task_teardown', 'task_abort', 'task_recover'])
  assert.deepEqual(FIRSTMATE_ALLOWED_TOOLS, ['read', 'grep', 'find', 'ls', 'subagent', 'herdr_control', 'artifact'])
  assert.equal(isFirstmateControlAction('task_reconcile'), true)
  assert.equal(isFirstmateControlAction('agent_read'), false)
  assert.equal(isFirstmateControlAction('pane_run'), false)
  assert.equal(isFirstmateAllowedTool('read'), true)
  assert.equal(isFirstmateAllowedTool('edit'), false)
  assert.equal(isFirstmateAllowedTool('write'), false)
  assert.equal(isFirstmateAllowedTool('bash'), false)
})

test('Firstmate entrypoint parses before it can be loaded into a captain pane', async () => {
  await execFileAsync(process.execPath, ['--check', new URL('../extensions/firstmate/index.ts', import.meta.url).pathname])
})

test('worker reports are validated independently of worker lifecycle operations', () => {
  const report = {
    version: REPORT_VERSION,
    taskId: 'task-abc-12345678-123',
    outcome: 'completed',
    changedFiles: ['extensions/firstmate/index.ts'],
    tests: ['node --test tests/firstmate-delivery.test.mjs'],
    validation: ['report is complete'],
    blockers: [],
    summary: 'Completed the task.',
  }
  assert.deepEqual(validateWorkerReport(report, report.taskId), { report })
  assert.deepEqual(validateWorkerReport({ ...report, taskId: 'other-task' }, report.taskId), { error: 'report taskId does not match the durable task.' })
})

test('Firstmate permits only user-scoped browser QA subagent requests', () => {
  assert.equal(isAllowedFirstmateSubagentRequest({ agent: 'browser-tester', task: 'Run browser QA.' }), true)
  assert.equal(isAllowedFirstmateSubagentRequest({ tasks: [{ agent: 'browser-tester', task: 'Run browser QA.' }] }), true)
  assert.equal(isAllowedFirstmateSubagentRequest({ chain: [{ agent: 'browser-tester', task: 'Run browser QA.' }] }), true)
  assert.equal(isAllowedFirstmateSubagentRequest({ agent: 'worker', task: 'Implement the change.' }), false)
  assert.equal(isAllowedFirstmateSubagentRequest({ agent: 'browser-tester', task: 'Run browser QA.', agentScope: 'project' }), false)
  assert.equal(isAllowedFirstmateSubagentRequest({ tasks: [{ agent: 'browser-tester', task: 'Run browser QA.' }, { agent: 'worker', task: 'Implement the change.' }] }), false)
  assert.equal(isAllowedFirstmateSubagentRequest({ agent: 'browser-tester', task: 'Run browser QA.', tasks: [] }), false)
  assert.equal(isAllowedFirstmateSubagentRequest({ agent: 'browser-tester' }), false)
  assert.equal(isAllowedFirstmateSubagentRequest({}), false)
})

test('Firstmate injects visible-worker-only implementation instructions and guards subagent calls', async () => {
  const source = await readFile(new URL('../extensions/firstmate/index.ts', import.meta.url), 'utf8')
  assert.match(source, /herdr_control\.task_create \/ visible worker tabs for all implementation and code mutations/)
  assert.match(source, /only with agent: "browser-tester" for browser QA, never for implementation or reconnaissance/)
  assert.match(source, /event\.toolName === 'subagent' && !isAllowedFirstmateSubagentRequest\(event\.input\)/)
  assert.match(source, /isFirstmateAllowedTool\(event\.toolName\)/)
})

test('extension source keeps delivery and cleanup identity/return guards', async () => {
  const source = await readFile(new URL('../extensions/firstmate/index.ts', import.meta.url), 'utf8')
  assert.match(source, /import \{ assessLocalDelivery, canCleanupAfterDelivery \} from '\.\/delivery\.ts'/)
  assert.match(source, /task_deliver/)
  assert.match(source, /const createRawHelper = async/)
  assert.match(source, /'tab', 'create', '--workspace', workspaceId, '--cwd', cwd, '--label', label, '--no-focus'/)
  assert.match(source, /const closeRawHelper = async/)
  assert.match(source, /endpointListsConfirmAbsence\(/)
  assert.match(source, /return \{ closed: true, absent: true/)
  assert.match(source, /runHerdr\(\['tab', 'close', helper\.tabId\]/)
  assert.match(source, /deliveryHelperTabId/)
  assert.match(source, /leaseReturnHelperTabId/)
  assert.match(source, /deliveryTargetBranch/)
  assert.match(source, /task delivery requires a reconciled completed worker report/)
  assert.match(source, /idempotent: true/)
  assert.match(source, /task\.branch !== `firstmate\/\$\{taskId\}`/)
  assert.match(source, /git -C \"\$project\" merge --ff-only \"\$branch\"/)
  assert.match(source, /runHerdr\(\['pane', 'run', helper\.paneId/)
  assert.match(source, /taskTeardownRecord\.paneId.*taskTeardownRecord\.workerName.*taskTeardownRecord\.workerKind/)
  assert.match(source, /treehouse return --force/)
  assert.match(source, /leaseStatus: taskTeardownRecord\.worktreeProvider === 'treehouse' \? 'returned'/)
  assert.match(source, /leaseReturnStatus === 'returned'/)
  assert.match(source, /Treehouse lease return failed/)
  assert.match(source, /task teardown requires successful explicit local delivery before cleanup/)
  assert.match(source, /agent_status/)
  assert.match(source, /status !== 'idle' && status !== 'done'/)
})

test('Firstmate exposes guarded recovery for stale, blocked, failed, and active tasks', async () => {
  const source = await readFile(new URL('../extensions/firstmate/index.ts', import.meta.url), 'utf8')
  assert.match(source, /'task_abort'/)
  assert.match(source, /'task_recover'/)
  assert.match(source, /Herdr has no native agent stop command/)
  assert.match(source, /pane', 'close', task\.paneId/)
  assert.match(source, /leased worktree recovery requires explicit discard: true/)
  assert.match(source, /worker endpoint cleanup was not verified; preserving durable state/)
  assert.match(source, /canDeleteWithoutRecordedEndpoint\(task\.endpointStatus\)/)
  assert.match(source, /endpointStatus: 'unverified'/)
  assert.match(source, /hasExactWorkerIdentity\(/)
  assert.match(source, /params\.force \? await runHerdr\(\['pane', 'close', task\.paneId!\]/)
  assert.match(source, /forced pane close did not verify the worker pane absent/)
  assert.match(source, /tempCleanupSucceeded/)
  assert.match(source, /deliveryTempCleanupSucceeded/)
  assert.match(source, /deliverySuccess = mergeSuccess && deliveryTempCleanupSucceeded && helperClose.closed/)
  assert.match(source, /LIFECYCLE_ACTIONS = new Set<FirstmateControlAction>\(\['task_create', 'task_reconcile'/)
  assert.match(source, /could not persist started worker state/)
  assert.match(source, /worker started but its prompt could not be delivered/)
  const abortStart = source.indexOf("case 'task_abort'")
  const abortEnd = source.indexOf("case 'task_teardown'", abortStart)
  const abortSource = source.slice(abortStart, abortEnd)
  assert.ok(abortSource.indexOf('leased worktree recovery requires explicit discard') < abortSource.indexOf("['pane', 'close', task.paneId"))
  assert.match(source, /removeTaskArtifacts\(taskId, true\)/)
  assert.match(source, /recorded worker endpoint is absent; recovered during shared-task admission/)
  assert.match(source, /const SHARED_ADMISSION_LOCK_PREFIX/)
  assert.match(source, /await fs\.promises\.mkdir\(lockPath/)
  const ownerWrite = source.match(/await fs\.promises\.writeFile\(ownerPath,[^\n]+/)?.[0]
  assert.equal(ownerWrite, "await fs.promises.writeFile(ownerPath, `${JSON.stringify(record, null, 2)}\\n`, { encoding: 'utf8', mode: 0o600 })")
  assert.match(source, /await fs\.promises\.rename\(lockPath, stalePath\)/)
})

test('failed and blocked reconciliation uses guarded shared cleanup without teardown or force', async () => {
  const source = await readFile(new URL('../extensions/firstmate/index.ts', import.meta.url), 'utf8')
  const cleanupStart = source.indexOf('const reconcileFailedSharedTask = async')
  const cleanupEnd = source.indexOf('const returnTaskLease = async', cleanupStart)
  const cleanup = source.slice(cleanupStart, cleanupEnd)
  const reconcileStart = source.indexOf("case 'task_reconcile'")
  const reconcileEnd = source.indexOf("case 'task_deliver'", reconcileStart)
  const reconcile = source.slice(reconcileStart, reconcileEnd)

  assert.ok(cleanupStart >= 0 && cleanupEnd > cleanupStart)
  assert.match(cleanup, /hasExactWorkerIdentity\(/)
  assert.match(cleanup, /tab\.pane_count === 1/)
  assert.match(cleanup, /status !== 'idle' && status !== 'done'/)
  assert.match(cleanup, /runHerdr\(\['tab', 'close', task\.tabId\]/)
  assert.match(cleanup, /endpointListsConfirmAbsence\(/)
  assert.match(cleanup, /removeTaskArtifacts\(task\.taskId, false\)/)
  assert.doesNotMatch(cleanup, /params\.force/)
  assert.doesNotMatch(cleanup, /returnTaskLease/)
  assert.match(reconcile, /reconcileFailedSharedTask\(reconciledTask, report\.outcome\)/)
  assert.match(reconcile, /nextAction: cleanup\.guidance/)
  assert.match(reconcile, /already has verified terminal worker cleanup/)
  assert.match(reconcile, /no task_teardown is required/)
  assert.match(cleanup, /Treehouse lease and worker changes were preserved/)
  assert.match(cleanup, /task_abort\/task_recover with force:true and discard:true/)
  assert.match(source, /\(record\.reportStatus === 'failed' \|\| record\.reportStatus === 'blocked'\)/)
  assert.match(source, /a failed or blocked shared task still requires explicit task_abort\/task_recover/)
})

test('completed shared reconciliation returns the report without implicit teardown', async () => {
  const source = await readFile(new URL('../extensions/firstmate/index.ts', import.meta.url), 'utf8')
  const reconcileStart = source.indexOf("case 'task_reconcile'")
  const reconcileEnd = source.indexOf("case 'task_deliver'", reconcileStart)
  const reconcile = source.slice(reconcileStart, reconcileEnd)

  assert.ok(reconcileStart >= 0 && reconcileEnd > reconcileStart)
  assert.match(reconcile, /text: JSON\.stringify\(report, null, 2\)/)
  assert.doesNotMatch(reconcile, /action = 'task_teardown'/)
  assert.doesNotMatch(source, /for \(;;\) \{\s+switch \(action\)/)
  assert.match(source, /shared-checkout tasks are already local and must not use task_deliver; reconcile, then use task_teardown/)
  assert.match(source, /task teardown requires successful explicit local delivery before cleanup/)
  assert.match(source, /status !== 'idle' && status !== 'done'/)
})

test('Firstmate delegates broad read-heavy work asynchronously with bounded visible fan-out', async () => {
  const source = await readFile(new URL('../extensions/firstmate/index.ts', import.meta.url), 'utf8')
  const agents = `${source}\n${await readFile(new URL('../AGENTS.md', import.meta.url), 'utf8')}`
  assert.match(agents, /broad codebase reconnaissance and read-heavy investigation/i)
  assert.match(agents, /one visible worker(?: is)? the default/i)
  assert.match(agents, /two only for genuinely independent, bounded scopes/i)
  assert.match(agents, /no uncontrolled fan-out/i)
  assert.match(agents, /narrow one-file questions may be inspected directly/i)
  assert.match(source, /task_create is asynchronous\/no-wait/i)
  assert.match(source, /rely on watcher follow-ups rather than polling/i)
  const taskCreateStart = source.indexOf("case 'task_create'")
  const taskCreateEnd = source.indexOf("case 'task_reconcile'", taskCreateStart)
  const taskCreate = source.slice(taskCreateStart, taskCreateEnd)
  assert.match(taskCreate, /const promptArgs = \['agent', 'prompt'/)
  assert.doesNotMatch(taskCreate, /promptArgs\.push\('--wait'/)
  assert.match(source, /promptGuidelines: \[[\s\S]*one visible (?:implementation )?worker by default/i)
})

test('watcher reports and latches unverified endpoints while status exposes durable task visibility', async () => {
  const source = await readFile(new URL('../extensions/firstmate/index.ts', import.meta.url), 'utf8')
  const notifyStart = source.indexOf('function notifyWatcher')
  const notifyEnd = source.indexOf('async function pollWatcher', notifyStart)
  const notifySource = source.slice(notifyStart, notifyEnd)
  assert.match(notifySource, /pi\.sendUserMessage\(message, \{ deliverAs: 'steer' \}\)/)
  assert.doesNotMatch(notifySource, /deliverAs: 'followUp'/)
  assert.match(source, /type WatcherObservation = \{ state\?: NativeWorkerState; edgeLatched: boolean; endpointMissingLatched: boolean \}/)
  assert.match(source, /function notifyMissingEndpoint\(task: TaskRecord\)/)
  assert.match(source, /runHerdr\(\['agent', 'get'.*result\.code !== 0/s)
  assert.match(source, /Do not classify it as idle\/done or completed/)
  assert.match(source, /endpointMissingLatched\s*=\s*notifyWatcher\(/)
  assert.match(source, /watcherMissingEndpoints\.delete\(task\.taskId\)/)
  assert.match(source, /unverifiedWorkers: \[\.\.\.watcherMissingEndpoints\.values\(\)\]/)
  assert.match(source, /durableTasks/)
  assert.match(source, /const active = records\.filter/)
  assert.match(source, /const stale = records\.filter/)
  assert.match(source, /record\.reportStatus !== 'blocked'/)
  assert.match(source, /const missing = records\.filter/)
  assert.match(source, /function watcherTaskCandidate\(task: TaskRecord, workspaceId: string\)/)
  assert.match(source, /task\.reportStatus !== 'completed'/)
  assert.match(source, /task\.reportStatus !== 'failed'/)
  assert.match(source, /return \{ total: records\.length, active, stale, missing, records \}/)
})

test('Treehouse provisioning resolves the base ref and creates the worker branch in the leased worktree before start', async () => {
  const source = await readFile(new URL('../extensions/firstmate/index.ts', import.meta.url), 'utf8')
  const taskCreateStart = source.indexOf("case 'task_create'")
  const taskCreateEnd = source.indexOf("case 'task_reconcile'", taskCreateStart)
  const provisioning = source.slice(taskCreateStart, taskCreateEnd)
  assert.match(provisioning, /treehouse get --lease/)
  assert.match(source, /origin_head=\$\(git symbolic-ref --quiet --short refs\/remotes\/origin\/HEAD/)
  assert.match(source, /for candidate in main master/)
  assert.match(source, /git switch --create "\$branch" -- "\$base"/)
  assert.match(provisioning, /const branchSetupCommand = treehouseWorkerBranchCommand\(branch, task\.reviewTarget\)/)
  assert.match(provisioning, /runHerdr\(branchSetupArgs, signal, timeout\)/)
  assert.ok(provisioning.indexOf('branchSetupArgs') < provisioning.indexOf("const startArgs = ['agent', 'start'"), 'branch setup must precede agent start')
  assert.doesNotMatch(provisioning, /treehouse get --lease.*--branch/)
})

test('reviewTarget is an additive inspection input and keeps review cleanup separate from delivery', async () => {
  const source = await readFile(new URL('../extensions/firstmate/index.ts', import.meta.url), 'utf8')
  assert.match(source, /reviewTarget: Type\.Optional\(Type\.String/)
  assert.match(source, /reviewTarget\?: string/)
  assert.match(source, /review_target=\$\{shellQuote\(reviewTarget \|\| ''\)\}/)
  assert.match(source, /This is a review task\. Inspect the existing target ref/)
  assert.match(source, /review tasks are inspection-only and cannot be locally delivered/)
  assert.match(source, /const reviewTask = typeof task\.reviewTarget === 'string'/)
  assert.match(source, /task\.worktreeProvider === 'treehouse'\s*&&\s*!reviewTask\s*&&\s*\(!canCleanupAfterDelivery\(/)
})

test('delivery targets the current branch, checks NUL-delimited dirty-path overlap, and retains backwards-safe state handling', async () => {
  const source = await readFile(new URL('../extensions/firstmate/index.ts', import.meta.url), 'utf8')
  const deliveryStart = source.indexOf("case 'task_deliver'")
  const deliveryEnd = source.indexOf("case 'task_teardown'", deliveryStart)
  const delivery = source.slice(deliveryStart, deliveryEnd)
  assert.match(delivery, /target_ref=\$\(git -C "\$project" symbolic-ref --quiet HEAD/)
  assert.match(delivery, /case "\$target_ref" in refs\/heads\/\*\) target=/)
  assert.match(delivery, /merge-base --is-ancestor "\$target" "\$branch"/)
  assert.ok(delivery.includes('target=%s\\\\ndirty_paths_check=%s\\\\ndirty_paths_overlap=%s'))
  assert.match(delivery, /diff --name-only -z/)
  assert.match(delivery, /diff --cached --name-only -z/)
  assert.match(delivery, /ls-files --others --exclude-standard -z/)
  assert.match(delivery, /diff --name-only --no-renames -z "\$target" "\$branch" > "\$worker_paths"/)
  assert.match(delivery, /entries\.push\(bytes\.subarray\(start,index\)\)/)
  assert.match(delivery, /dirtyAncestors/)
  assert.match(delivery, /shellQuote\(process\.execPath\)/)
  assert.doesNotMatch(delivery, /refs\/remotes\/origin\/HEAD/)
  assert.match(delivery, /deliveryTargetBranch: values\.target,\s+deliveryDefaultBranch: undefined/)
  assert.match(delivery, /task\.deliveryTargetBranch \|\| task\.deliveryDefaultBranch/)
})

test('delivery refusal records a failure without exiting before wrapper status write', async () => {
  const source = await readFile(new URL('../extensions/firstmate/index.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /refusing local delivery:[^']+' >&2; exit 1/)
  assert.match(source, /refusing local delivery:[^']+' >&2; code=1; else before=/)
})

test('delivery runs a durable shell script through the short helper command', async () => {
  const source = await readFile(new URL('../extensions/firstmate/index.ts', import.meta.url), 'utf8')
  assert.match(source, /const deliveryScriptPath = path\.join\(TASK_STATE_DIR, `\.\$\{taskId\}\.delivery\.sh`\)/)
  assert.match(source, /fs\.promises\.writeFile\(deliveryScriptPath, deliveryScript, \{ encoding: 'utf8', mode: 0o700 \}\)/)
  assert.match(source, /fs\.promises\.chmod\(deliveryScriptPath, 0o700\)/)
  assert.ok(source.includes("const deliveryCommand = `sh ${shellQuote(deliveryScriptPath)} > ${shellQuote(stdoutPath)} 2> ${shellQuote(stderrPath)}; printf '%s\\\\n' \"$?\" > ${shellQuote(statusPath)}`"))
  assert.match(source, /runHerdr\(\['pane', 'run', helper\.paneId, deliveryCommand\]/)
  assert.match(source, /rm -f \$\{shellQuote\(deliveryScriptPath\)\} \$\{shellQuote\(evidencePath\)\}/)
  assert.match(source, /fs\.promises\.unlink\(deliveryScriptPath\)/)
  assert.doesNotMatch(source, /const deliveryCommand = `project=/)
})

test('delivery parses evidence and status lines without over-escaped regexes', async () => {
  const source = await readFile(new URL('../extensions/firstmate/index.ts', import.meta.url), 'utf8')
  const parsingStart = source.indexOf('const values = Object.fromEntries')
  const parsingEnd = source.indexOf('const tempCleanup =', parsingStart)
  const parsing = source.slice(parsingStart, parsingEnd)
  assert.ok(parsing.includes('evidenceText.split(/\\r?\\n/)'))
  assert.ok(parsing.includes('&& /^-?\\d+$/.test'))
  assert.ok(!parsing.includes('evidenceText.split(/\\\\r?\\\\n/)'))
  assert.ok(!parsing.includes('&& /^-?\\\\d+$/.test'))
})

test('teardown recognizes the explicit Treehouse return success marker without status', async () => {
  const source = await readFile(new URL('../extensions/firstmate/index.ts', import.meta.url), 'utf8')
  const returnStart = source.indexOf('const returnTaskLease = async')
  const returnEnd = source.indexOf('let args: string[]', returnStart)
  const returnSection = source.slice(returnStart, returnEnd)
  assert.ok(returnSection.includes('output.includes(TREEHOUSE_RETURN_SUCCESS_MARKER)'))
  assert.ok(returnSection.includes('const markerSucceeded = code === null && returnSuccessMarker'))
  assert.ok(returnSection.includes('const commandSucceeded = (!error && code === 0) || markerSucceeded'))
  assert.ok(returnSection.includes("leaseStatus: returned ? 'returned' : 'leased'"))
  assert.ok(returnSection.includes('const tempCleanupSucceeded = tempCleanup.code === 0'))
  assert.ok(returnSection.includes('canMarkLeaseReturned({ commandSucceeded, tempCleanupSucceeded, helperClosed: helperClose.closed })'))
})

test('teardown recovers an absent recorded worker tab after durable return success', async () => {
  const source = await readFile(new URL('../extensions/firstmate/index.ts', import.meta.url), 'utf8')
  const teardownStart = source.indexOf("case 'task_teardown'")
  const teardownEnd = source.indexOf('const result = await runHerdr', teardownStart)
  const teardownSource = source.slice(teardownStart, teardownEnd)
  assert.ok(teardownSource.includes("leaseStatus === 'leased'"))
  assert.ok(teardownSource.includes('TREEHOUSE_RETURN_SUCCESS_MARKER'))
  assert.ok(teardownSource.includes("runHerdr(['tab', 'list', '--workspace', targetWorkspaceId]"))
  assert.ok(teardownSource.includes("runHerdr(['pane', 'list', '--workspace', targetWorkspaceId]"))
  assert.ok(teardownSource.includes('recordedTabAbsent && recordedPaneAbsent'))
  assert.ok(teardownSource.includes('const sharedRecoveryEligible = taskTeardownRecord?.worktreeProvider === \'herdr\''))
  assert.ok(teardownSource.includes('endpointStatus: \'absent_verified\''))
  assert.match(teardownSource, /leaseStatus: 'returned',\s+leaseReturnStatus: 'returned'/)
  assert.ok(teardownSource.includes('taskTeardownTabAlreadyAbsent = true'))
  assert.ok(teardownSource.includes('if (taskTeardownTabAlreadyAbsent)'))
  assert.ok(teardownSource.includes('workerTabAbsent: true'))
  assert.ok(source.includes('let taskTeardownReport: WorkerReport | undefined'))
  assert.ok(teardownSource.includes('taskTeardownReport = validation.report'))
  assert.ok(teardownSource.includes('report: taskTeardownReport'))
  const postCloseVerification = source.indexOf('const endpointAbsent = endpointListsConfirmAbsence', teardownStart)
  const leaseAfterCloseVerification = source.indexOf('const leaseReturn = await returnTaskLease({ ...taskTeardownRecord, endpointStatus: \'absent_verified\' })', postCloseVerification)
  assert.ok(postCloseVerification >= 0 && leaseAfterCloseVerification > postCloseVerification)
})

test('Firstmate defaults to session-scoped shared isolation and can switch to worktrees', async () => {
  const source = await readFile(new URL('../extensions/firstmate/index.ts', import.meta.url), 'utf8')
  const taskCreateStart = source.indexOf("case 'task_create'")
  const taskCreateEnd = source.indexOf("case 'task_reconcile'", taskCreateStart)
  const taskCreate = source.slice(taskCreateStart, taskCreateEnd)
  const teardownStart = source.indexOf("case 'task_teardown'")
  const teardownEnd = source.indexOf("case 'tab_close'", teardownStart)
  const teardown = source.slice(teardownStart, teardownEnd)

  assert.match(source, /const ISOLATION_STATE_ENTRY = 'firstmate-isolation'/)
  assert.match(source, /let isolationMode: IsolationMode = 'shared'/)
  assert.match(source, /pi\.registerCommand\('firstmate-isolation'/)
  assert.match(source, /pi\.appendEntry\(ISOLATION_STATE_ENTRY, \{ mode: requested \}\)/)
  assert.match(source, /restoreIsolationMode\(ctx\)/)
  assert.match(taskCreate, /const taskIsolation = isolationMode/)
  assert.match(taskCreate, /worktreeProvider: taskIsolation === 'shared' \? 'herdr' : 'treehouse'/)
  assert.match(taskCreate, /if \(taskIsolation === 'worktree'\) \{\s+const leaseArgs/)
  assert.match(taskCreate, /fs\.promises\.realpath\(project\)/)
  assert.match(taskCreate, /a shared-checkout task is already active for this project/)
  assert.match(taskCreate, /reviewTarget tasks require worktree isolation/)
  assert.match(source, /shared-checkout tasks are already local and must not use task_deliver/)
  assert.match(teardown, /task\.worktreeProvider === 'treehouse'\s*&&\s*!reviewTask/)
  assert.match(teardown, /leaseNotRequired: task\.worktreeProvider === 'herdr'/)
})

test('Firstmate workers and subagents have a hard no-push guard', async () => {
  const firstmate = await readFile(new URL('../extensions/firstmate/index.ts', import.meta.url), 'utf8')
  const permissionGate = await readFile(new URL('../extensions/permission-gate.ts', import.meta.url), 'utf8')
  const gitWrapper = await readFile(new URL('../extensions/firstmate/worker-git/git', import.meta.url), 'utf8')

  assert.doesNotMatch(firstmate, /case 'pane_run'/)
  assert.match(firstmate, /export \$\{WORKER_ENV\}=1/)
  assert.match(permissionGate, /const isFirstmateExecution = process\.env\.PI_FIRSTMATE_WORKER === "1"/)
  assert.match(permissionGate, /if \(isFirstmateExecution && containsGitPush\(command\)\)/)
  assert.match(permissionGate, /MCP calls are blocked for Firstmate implementation workers/)
  assert.match(permissionGate, /isBrowserTesterSubagent/)
  assert.match(firstmate, /FIRSTMATE_WORKER_BIN_DIR/)
  assert.match(firstmate, /PI_FIRSTMATE_REAL_GIT/)
  assert.match(gitWrapper, /\[ "\$argument" = "push" \]/)
  assert.match(gitWrapper, /exit 126/)
})

test('Firstmate activation gates the headless path while task_create starts visible workers', async () => {
  const source = await readFile(new URL('../extensions/firstmate/index.ts', import.meta.url), 'utf8')
  const sessionStart = source.slice(source.indexOf("pi.on('session_start'"), source.indexOf("pi.on('session_shutdown'"))
  const taskCreateStart = source.indexOf("case 'task_create'")
  const taskCreateEnd = source.indexOf("case 'task_reconcile'", taskCreateStart)
  const taskCreate = source.slice(taskCreateStart, taskCreateEnd)

  assert.match(sessionStart, /process\.env\[ACTIVE_ENV\] = '1'/)
  assert.match(source, /delete process\.env\[ACTIVE_ENV\]/)
  assert.match(sessionStart, /ctx\.ui\.setToolsExpanded\(false\)/)
  assert.match(source, /FIRSTMATE_ALLOWED_TOOLS/)
  assert.doesNotMatch(source, /FIRSTMATE_ALLOWED_TOOLS = \[[^\]]*mcp/)
  assert.match(taskCreate, /const startArgs = \['agent', 'start'/)
  assert.match(taskCreate, /const promptArgs = \['agent', 'prompt'/)
  assert.doesNotMatch(taskCreate, /subagent/)
})

test('herdr_control renders worker status and reports without orchestration noise', async () => {
  const source = await readFile(new URL('../extensions/firstmate/index.ts', import.meta.url), 'utf8')
  const toolStart = source.indexOf("name: 'herdr_control'")
  const toolEnd = source.indexOf('\n      },\n    })', toolStart)
  assert.ok(toolStart >= 0)
  assert.ok(toolEnd > toolStart)
  const tool = source.slice(toolStart, toolEnd)

  assert.match(source, /import \{ Text \} from '@earendil-works\/pi-tui'/)
  assert.match(tool, /renderCall\(_args, theme, context\)/)
  assert.match(tool, /theme\.fg\('warning', `⏳ \$\{label\}`\)/)
  assert.match(tool, /theme\.fg\('success', `✓ \$\{label\}`\)/)
  assert.match(tool, /theme\.fg\('error', `✗ \$\{label\}`\)/)
  assert.match(tool, /renderResult\(result, \{ isPartial \}, theme, context\)/)
  assert.match(tool, /if \(action !== 'task_reconcile'\) return new Text\('', 0, 0\)/)
  assert.match(tool, /workerReportRenderText\(result\.details\.report\)/)
  assert.match(source, /function workerReportRenderText\(/)
  assert.match(source, /Worker started and working\. Task ID:/)
  assert.match(source, /text: JSON\.stringify\(report, null, 2\)/)
  assert.match(source, /const FIRSTMATE_RENDER_MAX_CHARS = 2_000/)
  assert.match(source, /const FIRSTMATE_RENDER_MAX_LINES = 12/)
  assert.match(source, /lines\.slice\(0, FIRSTMATE_RENDER_MAX_LINES\)/)
  assert.match(source, /bounded\.length > FIRSTMATE_RENDER_MAX_CHARS/)
})

test('Pi worker starts append enforced Luna/high arguments', async () => {
  const source = await readFile(new URL('../extensions/firstmate/index.ts', import.meta.url), 'utf8')
  const helperStart = source.indexOf('function appendWorkerNativeArgs')
  const helperEnd = source.indexOf('\n\nexport default function firstmate', helperStart)
  const helper = source.slice(helperStart, helperEnd)
  const taskCreateStart = source.indexOf("case 'task_create'")
  const taskCreateEnd = source.indexOf("case 'task_reconcile'", taskCreateStart)
  const taskCreate = source.slice(taskCreateStart, taskCreateEnd)

  assert.ok(source.includes("const PI_WORKER_NATIVE_ARGS = ['--model', 'openai-codex/gpt-5.6-luna', '--thinking', 'high']"))
  assert.ok(helper.indexOf("args.push('--', ...nativeArgs)") < helper.indexOf('args.push(...PI_WORKER_NATIVE_ARGS)'))
  assert.match(helper, /if \(kind === 'pi'\) args\.push\(\.\.\.PI_WORKER_NATIVE_ARGS\)/)
  assert.ok(taskCreate.includes('appendWorkerNativeArgs(startArgs, kind)'))
  assert.doesNotMatch(source, /case 'agent_start'/)
})

test('Pi firstmate defaults to an allowlisted Pi worker and exposes a session selector', async () => {
  const source = await readFile(new URL('../extensions/firstmate/index.ts', import.meta.url), 'utf8')
  assert.match(source, /const ALLOWED_WORKER_KINDS = \['pi', 'claude'\] as const/)
  assert.match(source, /const DEFAULT_WORKER_KIND = 'pi' as const/)
  assert.match(source, /let selectedWorkerKind: WorkerKind = DEFAULT_WORKER_KIND/)
  assert.match(source, /pi\.registerCommand\('firstmate-worker'/)
  assert.match(source, /const taskWorkerKind = params\.kind === undefined \? selectedWorkerKind : params\.kind/)
  assert.doesNotMatch(source, /case 'agent_start'/)
})

test('Pi firstmate can select Claude for task workers without Pi native arguments', async () => {
  const source = await readFile(new URL('../extensions/firstmate/index.ts', import.meta.url), 'utf8')
  const taskCreateStart = source.indexOf("case 'task_create'")
  const taskCreateEnd = source.indexOf("case 'task_reconcile'", taskCreateStart)
  const taskCreate = source.slice(taskCreateStart, taskCreateEnd)

  assert.match(source, /StringEnum\(ALLOWED_WORKER_KINDS/)
  assert.match(source, /workerKind: taskWorkerKind/)
  assert.match(taskCreate, /const kind = taskWorkerKind/)
  assert.match(taskCreate, /appendWorkerNativeArgs\(startArgs, kind\)/)
  assert.match(source, /if \(kind === 'pi'\) args\.push\(\.\.\.PI_WORKER_NATIVE_ARGS\)/)
  assert.match(source, /workerReportContract\(taskId, reportPath\)/)
  assert.doesNotMatch(source, /workerReportContract[\s\S]{0,500}(?:Claude|Anthropic|provider)/i)
})

test('worker kind selection rejects invalid values and restores the latest persisted allowlisted value', async () => {
  const source = await readFile(new URL('../extensions/firstmate/index.ts', import.meta.url), 'utf8')
  assert.match(source, /function isWorkerKind\(value: unknown\): value is WorkerKind/)
  assert.match(source, /if \(!isWorkerKind\(value\)\) return '`kind` must be one of: pi, claude\.'/)
  assert.match(source, /value\.workerKind !== undefined && !isWorkerKind\(value\.workerKind\)/)
  assert.match(source, /const WORKER_STATE_ENTRY = 'firstmate-worker'/)
  assert.match(source, /function restoreWorkerKind\(/)
  assert.match(source, /entry\.customType !== WORKER_STATE_ENTRY/)
  assert.match(source, /selectedWorkerKind = entry\.data\.kind/)
  assert.match(source, /pi\.appendEntry\(WORKER_STATE_ENTRY, \{ kind: requested \}\)/)
  assert.match(source, /restoreWorkerKind\(ctx\)/)
})
