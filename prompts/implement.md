---
description: Focused implementation workflow
---

For a simple bounded task, invoke `worker` directly. If context is missing,
use `scout` then `worker`; do not add a planner or reviewer without a reason.
At every stage include the cumulative original request `$@`, authority and
commit limits, scope/files, acceptance criteria, and validation requirements.
`{previous}` is context only. Preserve unrelated changes, run the requested
checks, and report changed files, evidence, failures, and blockers.
