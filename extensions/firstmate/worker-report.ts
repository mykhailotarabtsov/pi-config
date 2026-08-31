import type { WorkerReport } from './task-state.ts'

export const REPORT_VERSION = 1

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function validateWorkerReport(value: unknown, taskId: string): { report?: WorkerReport; error?: string } {
  if (!isRecord(value)) return { error: 'report must be a JSON object.' }
  const fields = ['version', 'taskId', 'outcome', 'changedFiles', 'tests', 'validation', 'blockers', 'summary']
  const extraField = Object.keys(value).find((field) => !fields.includes(field))
  if (extraField) return { error: `report contains unknown field \`${extraField}\`.` }
  if (value.version !== REPORT_VERSION) return { error: `report version must be ${REPORT_VERSION}.` }
  if (value.taskId !== taskId) return { error: 'report taskId does not match the durable task.' }
  if (value.outcome !== 'completed' && value.outcome !== 'blocked' && value.outcome !== 'failed') return { error: 'report outcome must be completed, blocked, or failed.' }
  if (!Array.isArray(value.changedFiles) || !value.changedFiles.every((entry) => typeof entry === 'string')) return { error: 'report changedFiles must be an array of strings.' }
  if (!Array.isArray(value.tests) || !value.tests.every((entry) => typeof entry === 'string' || isRecord(entry))) return { error: 'report tests must be an array of strings or objects.' }
  if (!Array.isArray(value.validation) || !value.validation.every((entry) => typeof entry === 'string')) return { error: 'report validation must be an array of strings.' }
  if (!Array.isArray(value.blockers) || !value.blockers.every((entry) => typeof entry === 'string')) return { error: 'report blockers must be an array of strings.' }
  if (typeof value.summary !== 'string') return { error: 'report summary must be a string.' }
  return { report: value as WorkerReport }
}

export function workerReportContract(taskId: string, reportPath: string): string {
  return `

## Required structured worker report
Before claiming this task is complete, blocked, or failed, write a UTF-8 JSON report to the exact outside-project path ${reportPath}. The pane environment also exports PI_FIRSTMATE_TASK_ID=${taskId} and PI_FIRSTMATE_REPORT_PATH=${reportPath}. Do not rely on scrollback or a final message as the report. The report schema is exactly:
{
  "version": ${REPORT_VERSION},
  "taskId": "${taskId}",
  "outcome": "completed",
  "changedFiles": ["project-relative/path"],
  "tests": ["command/result"],
  "validation": ["validation result"],
  "blockers": ["blocker"],
  "summary": "concise summary"
}
The outcome must be exactly completed, blocked, or failed; tests entries may be strings or JSON objects; all other arrays contain strings. Write every required field, use empty arrays when applicable, and write the report before claiming completion. Preserve unrelated working-tree changes. Never push or publish changes. Do not commit unless the captain explicitly authorizes a local commit.`.trim()
}
