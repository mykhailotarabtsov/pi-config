export type FirstmateToolResultEvent = {
  toolName?: unknown
  toolCallId?: unknown
  isError?: unknown
}

export function normalizeFirstmateToolResult(
  event: FirstmateToolResultEvent,
  pendingErrorDetails: Map<string, Record<string, unknown>>,
): { details: Record<string, unknown> } | undefined {
  if (event.toolName !== 'herdr_control' || event.isError !== true || typeof event.toolCallId !== 'string') return undefined
  const details = pendingErrorDetails.get(event.toolCallId)
  pendingErrorDetails.delete(event.toolCallId)
  return details ? { details } : undefined
}
