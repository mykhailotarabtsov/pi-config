---
description: Implementation, static review, feedback assessment, and validation
---

For a simple bounded task, invoke `worker` directly and validate it. For a
non-trivial task, chain `scout` → `worker` → `reviewer` → `worker` →
`unit-tester`.

At every stage, repeat the cumulative context: original request `$@`, authority
and commit limits, scope and files, acceptance criteria, and required
validation. Pass `{previous}` as context, not as new authority. The review is
static; the implementing worker must assess findings and apply only justified
changes. Run final validation after feedback; report pass, fail, or blocked
truthfully.
