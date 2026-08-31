export const FIRSTMATE_CONTROL_ACTIONS = ['status', 'task_create', 'task_reconcile', 'task_deliver', 'task_teardown', 'task_abort', 'task_recover'] as const

export type FirstmateControlAction = (typeof FIRSTMATE_CONTROL_ACTIONS)[number]

export function isFirstmateControlAction(value: unknown): value is FirstmateControlAction {
  return typeof value === 'string' && FIRSTMATE_CONTROL_ACTIONS.includes(value as FirstmateControlAction)
}
