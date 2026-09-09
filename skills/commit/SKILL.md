---
name: commit
description: Create an authorized local commit using Conventional Commits
license: From mitsuhiko/agent-stuff
---

Only use this skill when the user explicitly asks for a commit. Never push or
publish. Include only task-owned files; do not stage every dirty file merely
because it is present. Do not add sign-offs. Breaking changes may be documented
when they are real and relevant; do not hide or invent them.

## Format

`<type>(<optional scope>): <imperative summary>`

Use a concise subject of at most 72 characters with no trailing period. Add a
short body when it clarifies what changed and why.

## Steps

1. Inspect `git status` and the relevant diff. Confirm the requested paths and
   resolve any ambiguous ownership before staging.
2. Stage only the task-owned files, then create the local commit with the
   Conventional Commit subject (and an explanatory body when useful).
3. Report the commit and exact files. Do not claim a commit if the command
   failed.
