import assert from 'node:assert/strict'
import test from 'node:test'
import { assessLocalDelivery, canCleanupAfterDelivery } from '../extensions/firstmate/delivery.ts'
import { readFile } from 'node:fs/promises'

const clean = { defaultBranch: 'main', currentBranch: 'main', clean: true, branchExists: true, fastForward: true }

test('delivery refuses wrong branch, dirty, missing branch, and diverged primary state', () => {
  assert.deepEqual(assessLocalDelivery({ ...clean, currentBranch: 'feature' }), { allowed: false, reason: 'wrong-branch' })
  assert.deepEqual(assessLocalDelivery({ ...clean, clean: false }), { allowed: false, reason: 'dirty' })
  assert.deepEqual(assessLocalDelivery({ ...clean, branchExists: false }), { allowed: false, reason: 'missing-branch' })
  assert.deepEqual(assessLocalDelivery({ ...clean, fastForward: false }), { allowed: false, reason: 'diverged' })
})

test('delivery permits a clean fast-forward and cleanup only after landing', () => {
  assert.deepEqual(assessLocalDelivery(clean), { allowed: true })
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
