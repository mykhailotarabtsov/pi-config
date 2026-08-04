export type LocalDeliveryProbe = {
  targetBranch: string
  dirtyPathCheckSucceeded: boolean
  dirtyPathsOverlap: boolean
  branchExists: boolean
  fastForward: boolean
}

export type LocalDeliveryDecision =
  | { allowed: true }
  | { allowed: false; reason: 'detached' | 'dirty-path-check-failed' | 'dirty-overlap' | 'missing-branch' | 'diverged' }

export function assessLocalDelivery(probe: LocalDeliveryProbe): LocalDeliveryDecision {
  if (!probe.targetBranch) return { allowed: false, reason: 'detached' }
  if (!probe.branchExists) return { allowed: false, reason: 'missing-branch' }
  if (!probe.fastForward) return { allowed: false, reason: 'diverged' }
  if (!probe.dirtyPathCheckSucceeded) return { allowed: false, reason: 'dirty-path-check-failed' }
  if (probe.dirtyPathsOverlap) return { allowed: false, reason: 'dirty-overlap' }
  return { allowed: true }
}

export function canCleanupAfterDelivery(input: { reportCompleted: boolean; deliveryStatus?: string; leaseStatus?: string }): boolean {
  return input.reportCompleted && input.deliveryStatus === 'landed' && (input.leaseStatus === 'leased' || input.leaseStatus === 'returned')
}
