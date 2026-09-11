export type LocalDeliveryScriptInput = {
  project: string
  worktree: string
  branch: string
  expectedTargetBranch: string
  evidencePath: string
  dirtyPathsPath: string
  workerPathsPath: string
  workerStatusPath: string
  repositoryIdentity: string
  reportedChanges: boolean
  nodePath: string
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

export function buildLocalDeliveryScript(input: LocalDeliveryScriptInput): string {
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

  return (
    [
      '#!/bin/sh',
      `project=${shellQuote(input.project)}`,
      `worktree=${shellQuote(input.worktree)}`,
      `branch=${shellQuote(input.branch)}`,
      `expected_target=${shellQuote(input.expectedTargetBranch)}`,
      `evidence=${shellQuote(input.evidencePath)}`,
      `dirty_paths=${shellQuote(input.dirtyPathsPath)}`,
      `worker_paths=${shellQuote(input.workerPathsPath)}`,
      `worker_status=${shellQuote(input.workerStatusPath)}`,
      `reported_changes=${input.reportedChanges ? 'true' : 'false'}`,
      `expected_repo_identity=${shellQuote(input.repositoryIdentity)}`,
      'repo_identity=$(git -C "$project" rev-parse --git-common-dir 2>/dev/null || true)',
      'case "$repo_identity" in /*) ;; *) repo_identity="$project/$repo_identity";; esac',
      'repo_identity=$(cd "$repo_identity" 2>/dev/null && pwd -P || true)',
      'if [ -n "$expected_repo_identity" ] && [ "$repo_identity" = "$expected_repo_identity" ]; then repo_identity_check=complete; else repo_identity_check=failed; fi',
      'target_ref=$(git -C "$project" symbolic-ref --quiet HEAD 2>/dev/null || true)',
      'case "$target_ref" in refs/heads/*) target="${target_ref#refs/heads/}";; *) target=;; esac',
      'if [ -n "$expected_target" ] && [ "$target" = "$expected_target" ]; then target_branch_matches=true; else target_branch_matches=false; fi',
      'if git -C "$project" show-ref --verify --quiet "refs/heads/$branch"; then branch_exists=true; else branch_exists=false; fi',
      'worker_ref=$(git -C "$worktree" symbolic-ref --quiet HEAD 2>/dev/null || true)',
      'if [ "$worker_ref" = "refs/heads/$branch" ]; then worker_branch_verified=true; else worker_branch_verified=false; fi',
      'worker_head=$(git -C "$worktree" rev-parse HEAD 2>/dev/null || true)',
      'branch_head=$(git -C "$project" rev-parse "$branch" 2>/dev/null || true)',
      'if [ -n "$worker_head" ] && [ "$worker_head" = "$branch_head" ]; then worker_head_matches=true; else worker_head_matches=false; fi',
      'if git -C "$worktree" status --porcelain=v1 -z --untracked-files=all > "$worker_status"; then if [ -s "$worker_status" ]; then worker_clean=false; else worker_clean=true; fi; else worker_clean=false; fi',
      'branch_has_changes=false',
      'if [ -n "$target" ] && [ "$branch_exists" = true ] && ! git -C "$project" diff --quiet "$target" "$branch"; then branch_has_changes=true; fi',
      'if [ "$reported_changes" = "$branch_has_changes" ]; then reported_changes_committed=true; else reported_changes_committed=false; fi',
      'dirty_paths_check=not-applicable',
      'dirty_paths_overlap=false',
      'if ! { git -C "$project" diff --name-only -z; git -C "$project" diff --cached --name-only -z; git -C "$project" ls-files --others --exclude-standard -z; } > "$dirty_paths"; then dirty_paths_check=failed; elif [ -n "$target" ] && [ "$branch_exists" = true ]; then if git -C "$project" diff --name-only --no-renames -z "$target" "$branch" > "$worker_paths"; then dirty_paths_check=complete; else dirty_paths_check=failed; fi; fi',
      `if [ "$dirty_paths_check" = complete ] && [ -s "$dirty_paths" ] && [ -s "$worker_paths" ]; then if ${shellQuote(input.nodePath)} -e ${shellQuote(dirtyPathOverlapCheck)} "$dirty_paths" "$worker_paths"; then dirty_paths_overlap=false; else case "$?" in 1) dirty_paths_overlap=true;; *) dirty_paths_check=failed;; esac; fi; fi`,
      'if [ -n "$target" ] && [ "$branch_exists" = true ] && git -C "$project" merge-base --is-ancestor "$target" "$branch"; then fast_forward=true; else fast_forward=false; fi',
      'printf \'target=%s\\ntarget_branch_matches=%s\\nrepo_identity_check=%s\\nworker_clean=%s\\nworker_branch_verified=%s\\nworker_head=%s\\nworker_head_matches=%s\\nreported_changes_committed=%s\\ndirty_paths_check=%s\\ndirty_paths_overlap=%s\\nbranch_exists=%s\\nfast_forward=%s\\n\' "$target" "$target_branch_matches" "$repo_identity_check" "$worker_clean" "$worker_branch_verified" "$worker_head" "$worker_head_matches" "$reported_changes_committed" "$dirty_paths_check" "$dirty_paths_overlap" "$branch_exists" "$fast_forward" > "$evidence"',
      'if [ -z "$target" ] || [ "$target_branch_matches" != true ] || [ "$repo_identity_check" != complete ] || [ "$worker_clean" != true ] || [ "$worker_branch_verified" != true ] || [ "$worker_head_matches" != true ] || [ "$reported_changes_committed" != true ] || [ "$dirty_paths_check" = failed ] || [ "$dirty_paths_overlap" != false ] || [ "$branch_exists" != true ] || [ "$fast_forward" != true ]; then echo \'refusing local delivery: target branch changed, worker changes are not fully committed and clean, worker identity changed, primary checkout safety checks failed, the branch is missing, or branches diverged\' >&2; code=1; else before=$(git -C "$project" rev-parse "$target"); git -C "$project" merge --ff-only "$branch"; code=$?; if [ "$code" -eq 0 ]; then after=$(git -C "$project" rev-parse "$target"); printf \'before=%s\\nafter=%s\\n\' "$before" "$after" >> "$evidence"; fi; fi',
      '[ "$code" -eq 0 ]',
    ].join('\n') + '\n'
  )
}

export type LocalDeliveryProbe = {
  targetBranch: string
  dirtyPathCheckSucceeded: boolean
  dirtyPathsOverlap: boolean
  branchExists: boolean
  fastForward: boolean
  repositoryIdentityCheckSucceeded?: boolean
  targetBranchMatches?: boolean
  workerClean?: boolean
  workerBranchVerified?: boolean
  workerHeadMatchesBranch?: boolean
  reportedChangesCommitted?: boolean
}

export type LocalDeliveryDecision =
  | { allowed: true }
  | {
      allowed: false
      reason:
        | 'detached'
        | 'dirty-path-check-failed'
        | 'dirty-overlap'
        | 'missing-branch'
        | 'diverged'
        | 'repository-identity-mismatch'
        | 'target-branch-mismatch'
        | 'worker-dirty'
        | 'worker-branch-mismatch'
        | 'worker-head-mismatch'
        | 'reported-changes-uncommitted'
    }

export function assessLocalDelivery(probe: LocalDeliveryProbe): LocalDeliveryDecision {
  if (!probe.targetBranch) return { allowed: false, reason: 'detached' }
  if (probe.repositoryIdentityCheckSucceeded === false) return { allowed: false, reason: 'repository-identity-mismatch' }
  if (probe.targetBranchMatches === false) return { allowed: false, reason: 'target-branch-mismatch' }
  if (probe.workerClean === false) return { allowed: false, reason: 'worker-dirty' }
  if (probe.workerBranchVerified === false) return { allowed: false, reason: 'worker-branch-mismatch' }
  if (probe.workerHeadMatchesBranch === false) return { allowed: false, reason: 'worker-head-mismatch' }
  if (probe.reportedChangesCommitted === false) return { allowed: false, reason: 'reported-changes-uncommitted' }
  if (!probe.branchExists) return { allowed: false, reason: 'missing-branch' }
  if (!probe.fastForward) return { allowed: false, reason: 'diverged' }
  if (!probe.dirtyPathCheckSucceeded) return { allowed: false, reason: 'dirty-path-check-failed' }
  if (probe.dirtyPathsOverlap) return { allowed: false, reason: 'dirty-overlap' }
  return { allowed: true }
}

export function canCleanupAfterDelivery(input: { reportCompleted: boolean; deliveryStatus?: string; leaseStatus?: string }): boolean {
  return input.reportCompleted && input.deliveryStatus === 'landed' && (input.leaseStatus === 'leased' || input.leaseStatus === 'returned')
}
