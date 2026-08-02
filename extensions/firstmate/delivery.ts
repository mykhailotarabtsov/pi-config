export type LocalDeliveryProbe = {
  defaultBranch: string
  currentBranch: string
  clean: boolean
  branchExists: boolean
  fastForward: boolean
}

export type LocalDeliveryDecision =
  | { allowed: true }
  | { allowed: false; reason: 'wrong-branch' | 'dirty' | 'missing-branch' | 'diverged' | 'no-default-branch' }

export function assessLocalDelivery(probe: LocalDeliveryProbe): LocalDeliveryDecision {
  if (!probe.defaultBranch) return { allowed: false, reason: 'no-default-branch' }
  if (probe.currentBranch !== probe.defaultBranch) return { allowed: false, reason: 'wrong-branch' }
  if (!probe.clean) return { allowed: false, reason: 'dirty' }
  if (!probe.branchExists) return { allowed: false, reason: 'missing-branch' }
  if (!probe.fastForward) return { allowed: false, reason: 'diverged' }
  return { allowed: true }
}

export function canCleanupAfterDelivery(input: { reportCompleted: boolean; deliveryStatus?: string; leaseStatus?: string }): boolean {
  return input.reportCompleted && input.deliveryStatus === 'landed' && (input.leaseStatus === 'leased' || input.leaseStatus === 'returned')
}
