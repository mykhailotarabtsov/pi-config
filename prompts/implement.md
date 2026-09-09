---
description: Focused implementation workflow
---

Firstmate guard: when `PI_FIRSTMATE_ACTIVE=1`, do not invoke a generic chain.
Route reconnaissance and file/Git work through visible
`herdr_control.task_create`; use headless `subagent` only for `browser-tester`
QA.

For a simple bounded task, invoke `worker` directly. If context is missing,
use `scout` then `worker`; do not add a planner or reviewer without a reason.
At every stage include the cumulative original request `$@`, authority and
commit limits, scope/files, acceptance criteria, and validation requirements.
`{previous}` is context only. Preserve unrelated changes, run the requested
checks, and report changed files, evidence, failures, and blockers.
