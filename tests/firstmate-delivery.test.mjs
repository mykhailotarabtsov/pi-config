import assert from 'node:assert/strict'
import test from 'node:test'
import { assessLocalDelivery, canCleanupAfterDelivery } from '../extensions/firstmate/delivery.ts'
import { readFile } from 'node:fs/promises'

const fastForward = { targetBranch: 'feature/current', dirtyPathCheckSucceeded: true, dirtyPathsOverlap: false, branchExists: true, fastForward: true }

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

test('extension source keeps delivery and cleanup identity/return guards', async () => {
  const source = await readFile(new URL('../extensions/firstmate/index.ts', import.meta.url), 'utf8')
  assert.match(source, /import \{ assessLocalDelivery, canCleanupAfterDelivery \} from '\.\/delivery\.ts'/)
  assert.match(source, /task_deliver/)
  assert.match(source, /const createRawHelper = async/)
  assert.match(source, /'tab', 'create', '--workspace', workspaceId, '--cwd', cwd, '--label', label, '--no-focus'/)
  assert.match(source, /const closeRawHelper = async/)
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
  assert.match(source, /Treehouse lease return failed; preserving the worker tab and lease/)
  assert.match(source, /task teardown requires successful explicit local delivery before cleanup/)
  assert.match(source, /agent_status/)
  assert.match(source, /status !== 'idle' && status !== 'done'/)
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
  assert.match(source, /if \(task\.worktreeProvider === 'treehouse' && !reviewTask && \(!canCleanupAfterDelivery\(/)
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
  assert.match(delivery, /deliveryTargetBranch: values\.target, deliveryDefaultBranch: undefined/)
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
  const returnEnd = source.indexOf('const returnLeasedWorktree = async', returnStart)
  const returnSection = source.slice(returnStart, returnEnd)
  assert.ok(returnSection.includes('output.includes(TREEHOUSE_RETURN_SUCCESS_MARKER)'))
  assert.ok(returnSection.includes('const markerSucceeded = code === null && returnSuccessMarker'))
  assert.ok(returnSection.includes('const commandSucceeded = (!error && code === 0) || markerSucceeded'))
  assert.ok(returnSection.includes("leaseStatus: commandSucceeded ? 'returned' : 'leased'"))
})

test('teardown recovers an absent recorded worker tab after durable return success', async () => {
  const source = await readFile(new URL('../extensions/firstmate/index.ts', import.meta.url), 'utf8')
  const teardownStart = source.indexOf("case 'task_teardown'")
  const teardownEnd = source.indexOf('const result = await runHerdr', teardownStart)
  const teardownSource = source.slice(teardownStart, teardownEnd)
  assert.ok(teardownSource.includes("leaseReturnStatus === 'failed'"))
  assert.ok(teardownSource.includes('TREEHOUSE_RETURN_SUCCESS_MARKER'))
  assert.ok(teardownSource.includes("runHerdr(['tab', 'list', '--workspace', targetWorkspaceId]"))
  assert.ok(teardownSource.includes("runHerdr(['pane', 'list', '--workspace', targetWorkspaceId]"))
  assert.ok(teardownSource.includes('recordedTabAbsent && recordedPaneAbsent'))
  assert.ok(teardownSource.includes("leaseStatus: 'returned', leaseReturnStatus: 'returned'"))
  assert.ok(teardownSource.includes('taskTeardownTabAlreadyAbsent = true'))
  assert.ok(teardownSource.includes('workerTabAbsent: true'))
  assert.ok(source.includes('let taskTeardownReport: WorkerReport | undefined'))
  assert.ok(teardownSource.includes('taskTeardownReport = validation.report'))
  assert.ok(teardownSource.includes('report: taskTeardownReport'))
})

test('Firstmate defaults to session-scoped shared isolation and can switch to worktrees', async () => {
  const source = await readFile(new URL('../extensions/firstmate/index.ts', import.meta.url), 'utf8')
  const taskCreateStart = source.indexOf("case 'task_create'")
  const taskCreateEnd = source.indexOf("case 'task_reconcile'", taskCreateStart)
  const taskCreate = source.slice(taskCreateStart, taskCreateEnd)
  const teardownStart = source.indexOf("case 'task_teardown'")
  const teardownEnd = source.indexOf("case 'tab_create'", teardownStart)
  const teardown = source.slice(teardownStart, teardownEnd)

  assert.match(source, /const ISOLATION_STATE_ENTRY = 'firstmate-isolation'/)
  assert.match(source, /let isolationMode: IsolationMode = 'shared'/)
  assert.match(source, /pi\.registerCommand\('firstmate-isolation'/)
  assert.match(source, /pi\.appendEntry\(ISOLATION_STATE_ENTRY, \{ mode: requested \}\)/)
  assert.match(source, /restoreIsolationMode\(ctx\)/)
  assert.match(taskCreate, /const taskIsolation = isolationMode/)
  assert.match(taskCreate, /worktreeProvider: taskIsolation === 'shared' \? 'herdr' : 'treehouse'/)
  assert.match(taskCreate, /if \(taskIsolation === 'worktree'\) \{\n              const leaseArgs/)
  assert.match(taskCreate, /fs\.promises\.realpath\(project\)/)
  assert.match(taskCreate, /a shared-checkout task is already active for this project/)
  assert.match(taskCreate, /reviewTarget tasks require worktree isolation/)
  assert.match(source, /shared-checkout tasks are already local and must not use task_deliver/)
  assert.match(teardown, /task\.worktreeProvider === 'treehouse' && !reviewTask/)
  assert.match(teardown, /leaseNotRequired: task\.worktreeProvider === 'herdr'/)
})

test('Firstmate workers and subagents have a hard no-push guard', async () => {
  const firstmate = await readFile(new URL('../extensions/firstmate/index.ts', import.meta.url), 'utf8')
  const permissionGate = await readFile(new URL('../extensions/permission-gate.ts', import.meta.url), 'utf8')
  const gitWrapper = await readFile(new URL('../extensions/firstmate/worker-git/git', import.meta.url), 'utf8')

  assert.ok(firstmate.includes('const GIT_PUSH_COMMAND = /\\bgit'))
  assert.match(firstmate, /if \(containsGitPush\(params\.command\)\) return errorResult\('git push is blocked/)
  assert.match(firstmate, /export \$\{WORKER_ENV\}=1/)
  assert.match(permissionGate, /const isFirstmateExecution = process\.env\.PI_FIRSTMATE_WORKER === "1"/)
  assert.match(permissionGate, /if \(isFirstmateExecution && containsGitPush\(command\)\)/)
  assert.match(permissionGate, /MCP calls are blocked for Firstmate workers and their subagents/)
  assert.match(firstmate, /FIRSTMATE_WORKER_BIN_DIR/)
  assert.match(firstmate, /PI_FIRSTMATE_REAL_GIT/)
  assert.match(gitWrapper, /\[ "\$argument" = "push" \]/)
  assert.match(gitWrapper, /exit 126/)
})

test('Pi worker starts append enforced Luna/high arguments after caller native arguments', async () => {
  const source = await readFile(new URL('../extensions/firstmate/index.ts', import.meta.url), 'utf8')
  const helperStart = source.indexOf('function appendWorkerNativeArgs')
  const helperEnd = source.indexOf('\n\nexport default function firstmate', helperStart)
  const helper = source.slice(helperStart, helperEnd)
  const taskCreateStart = source.indexOf("case 'task_create'")
  const taskCreateEnd = source.indexOf("case 'task_reconcile'", taskCreateStart)
  const taskCreate = source.slice(taskCreateStart, taskCreateEnd)
  const manualStart = source.indexOf("case 'agent_start'")
  const manualEnd = source.indexOf("case 'agent_prompt'", manualStart)
  const manual = source.slice(manualStart, manualEnd)

  assert.ok(source.includes("const PI_WORKER_NATIVE_ARGS = ['--model', 'openai-codex/gpt-5.6-luna', '--thinking', 'high']"))
  assert.ok(helper.indexOf("args.push('--', ...nativeArgs)") < helper.indexOf('args.push(...PI_WORKER_NATIVE_ARGS)'))
  assert.match(helper, /if \(kind === 'pi'\) args\.push\(\.\.\.PI_WORKER_NATIVE_ARGS\)/)
  assert.ok(taskCreate.includes('appendWorkerNativeArgs(startArgs, kind)'))
  assert.ok(manual.includes('appendWorkerNativeArgs(args, kind!, params.args)'))
})
