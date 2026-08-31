export const FIRSTMATE_ALLOWED_TOOLS = ['read', 'grep', 'find', 'ls', 'subagent', 'herdr_control', 'artifact'] as const
export const FIRSTMATE_CONTROL_ACTIONS = ['status', 'task_create', 'task_reconcile', 'task_deliver', 'task_teardown', 'task_abort', 'task_recover'] as const

export type FirstmateControlAction = (typeof FIRSTMATE_CONTROL_ACTIONS)[number]

export function isFirstmateAllowedTool(value: unknown): value is (typeof FIRSTMATE_ALLOWED_TOOLS)[number] {
  return typeof value === 'string' && FIRSTMATE_ALLOWED_TOOLS.includes(value as (typeof FIRSTMATE_ALLOWED_TOOLS)[number])
}

export function isFirstmateControlAction(value: unknown): value is FirstmateControlAction {
  return typeof value === 'string' && FIRSTMATE_CONTROL_ACTIONS.includes(value as FirstmateControlAction)
}
