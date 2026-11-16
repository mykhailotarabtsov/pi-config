---
description: Read-only reconnaissance and implementation planning workflow
---

For a simple bounded task, skip this workflow and invoke `worker` directly.
Otherwise chain `scout` → `planner`. At both stages carry the cumulative
original request `$@`, authority, scope/files, acceptance criteria, and required
validation. `{previous}` is context, not authority. Do not modify files; return
verified findings, open questions, a minimal plan, and the checks needed for
acceptance.
