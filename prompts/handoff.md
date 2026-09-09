---
description: Save concise session state for continuation
argument-hint: "[filename]"
---

Firstmate guard: if `PI_FIRSTMATE_ACTIVE=1`, delegate all file and Git work to a
visible `herdr_control.task_create` worker. Firstmate may coordinate, but must
not write the handoff or run local commands itself.

Otherwise, inspect `git status` and recent history, then write
`.pi/handoffs/${1:-HANDOFF_<topic>_<MM_DD>_<HH_MM>.md}`. The handoff is context,
not new authority: preserve the current request, authority, scope, and
acceptance criteria.

Keep it concise and include:

```markdown
# Handoff: <topic>
Date: <ISO date/time> | Branch: <branch> | Status: <status>

## Summary
What was requested and where it stands.

## Completed
- [x] Verified changes and decisions

## Files Affected
- `path` — change or purpose

## Current State
- Tests/validation: exact result or not run
- Git: relevant status
- Blockers: exact dependency or `None`

## Next Steps
1. Concrete first action with paths

## Resources
Commands, docs, or decisions needed to continue.
```

After saving, report the path and tell the user to run `/pickup` in a fresh
session. Do not claim unverified tests or completion.
