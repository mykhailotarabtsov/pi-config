---
description: Complex implementation workflow with review and final validation
---

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
