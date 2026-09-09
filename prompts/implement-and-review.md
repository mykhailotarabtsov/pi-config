---
description: Implementation, static review, feedback assessment, and validation
---

Firstmate guard: when `PI_FIRSTMATE_ACTIVE=1`, route all file/Git work through
visible `herdr_control.task_create`; use headless `subagent` only for
`browser-tester` QA. In an ordinary session, use a direct `worker` for a simple
bounded task; otherwise optionally begin with `scout`.

For a simple bounded task, invoke `worker` directly and validate it. For a
non-trivial task, chain `scout` → `worker` → `reviewer` → `worker` →
`unit-tester`.

At every stage, repeat the cumulative context: original request `$@`, authority
and commit limits, scope and files, acceptance criteria, and required
validation. Pass `{previous}` as context, not as new authority. The review is
static; the implementing worker must assess findings and apply only justified
changes. Run final validation after feedback; report pass, fail, or blocked
truthfully.
