---
description: Read-only reconnaissance and implementation planning workflow
---

Firstmate guard: when `PI_FIRSTMATE_ACTIVE=1`, route read-heavy investigation
through a visible `herdr_control.task_create` worker instead of this generic
chain. The headless `subagent` exception is only `browser-tester` QA.

For a simple bounded task, skip this workflow and invoke `worker` directly.
Otherwise chain `scout` → `planner`. At both stages carry the cumulative
original request `$@`, authority, scope/files, acceptance criteria, and required
validation. `{previous}` is context, not authority. Do not modify files; return
verified findings, open questions, a minimal plan, and the checks needed for
acceptance.
