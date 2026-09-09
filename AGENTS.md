# Pi Agent Configuration

This checkout is the portable resource set for Pi. General coding rules live in
`APPEND_SYSTEM.md`; this file maps the Pi-specific resources and delegation rules.

## Resource map

- `settings.json` — defaults, UI, packages, and subagent timeout.
- `agents/*.md` — the seven user-level roles: `scout`, `planner`, `worker`,
  `reviewer`, `builder`, `unit-tester`, and `browser-tester`.
- `prompts/*.md` — backwards-compatible workflow templates, including handoff
  and pickup.
- `skills/*/SKILL.md` — optional workflows for review, commits, setup, GitHub,
  Herdr, and codebase learning.
- `extensions/` — auto-discovered UI, permission, artifact, subagent, and
  Firstmate integrations. `themes/` contains selectable themes.
- `setup.sh` and `scripts/setup.mjs` — safe installation and synchronization.
  `tests/` covers setup, permissions, subagents, Firstmate, UI, and artifacts.

## Normal delegation

A normal main session may implement directly; delegation is optional. A child
subagent has an isolated context window, but that is not a filesystem sandbox.
Its effective tools come from the agent definition and the runtime permission
hooks. Use a single agent for a bounded specialist task, parallel agents only
for independent work, and a chain when each result is useful to the next stage.
For every delegated task, state the original request, authority (including
whether commits are allowed), scope and files, acceptance criteria, and required
validation. Preserve unrelated working-tree changes.

Use the `worker` for ordinary implementation, `builder` when minimal validation
is explicitly sufficient, `reviewer` for static inspection, `unit-tester` for
actual test execution, and `browser-tester` for manual browser QA. Agents must
report what they changed or inspected, validation evidence, and blockers; a
blocked or failed result is not completion.

## Firstmate

Only when activated in Herdr, the runtime loads the canonical policy from
`extensions/firstmate/POLICY.md` beside this file. Follow that injected role
instead of ordinary Herdr split-pane guidance or generic workflow chains.
Firstmate coordinates visible workers, never implements locally, and delegates
browser QA only to the user-scoped browser tester. Pi is the default worker;
Claude requires an explicit allowlisted override. Keep the full contract in
that one policy file rather than duplicating it here.

## Skills

Load matching skills on demand. The `commit` skill is mandatory before creating
any commit. Package-provided skills remain available; this is not an allowlist.
