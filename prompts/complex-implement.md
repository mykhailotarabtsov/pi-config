---
description: Complex implementation workflow with review and final validation
---

Firstmate guard: if `PI_FIRSTMATE_ACTIVE=1`, do not run this generic chain.
Route reconnaissance, implementation, and review through visible
`herdr_control.task_create`; use headless `subagent` only for the
`browser-tester` browser-QA exception. Otherwise use this workflow.

For a simple bounded task, use a direct `worker` and skip unnecessary planning.
For a complex task, chain `scout`, `planner`, `worker`, `reviewer`, `worker`,
then `unit-tester`.

Every stage must carry the cumulative context below; `{previous}` supplements
it and never replaces it:
- Original request: `$@`
- Authority: what may change, whether commits are authorized, and no push/publish
- Scope/files: in-scope paths and explicit exclusions
- Acceptance: observable completion criteria
- Validation: required checks and truthful reporting of blockers

Review findings are input, not commands: the second worker must assess each
finding against the original request before applying or rejecting it. Run final
validation after feedback and report changed files, evidence, and blockers.
