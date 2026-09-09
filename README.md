# Pi agent configuration

Portable Pi resources for local development: prompts, user agents, skills,
auto-discovered extensions, themes, and safe setup helpers.

## Inventory

- `settings.json` — provider/model defaults, UI settings, packages, and agent timeout.
- `agents/` — seven roles: scout, planner, worker, reviewer, builder,
  unit-tester, and browser-tester.
- `prompts/` — implementation, review, planning, handoff, and pickup templates.
- `skills/` — optional review, commit, GitHub, Herdr, MCP, and codebase workflows.
- `extensions/` — startup/UI, permission, artifacts, subagent, and Herdr-gated
  Firstmate integrations.
- `mcp.json` — the configured global MCP servers; the browser QA server is
  `chrome-devtools`.
- `themes/`, `models.json.template`, `package.json`, and `package-lock.json` —
  selectable themes, optional local provider template, and pinned runtime deps.

## Setup

Requirements: Node.js **22.19 or newer**, npm, and Pi (validated against **0.85.1**).
The test suite uses the installed Pi host libraries; set `PI_PACKAGE_DIR` to the
Pi package directory if it is not installed alongside your active Node runtime.

```sh
git clone <this-repository> ~/pi-config
cd ~/pi-config
./setup.sh
```

Use `./setup.sh --dry-run` to preview changes, or pass `--target PATH` to
install elsewhere. Setup synchronizes the managed resource tree, preserves
existing `settings.json`, `mcp.json`, and `models.json`, maintains backups and
an ownership manifest, skips disabled entries and external source symlinks, and
runs `npm ci --ignore-scripts`. Conflicting unowned files and modified obsolete
files are kept with a warning; only unchanged obsolete managed files are pruned.
Backups live in `.pi-agent-backups/`; `.pi-agent-managed.json` records ownership.
An in-place checkout at `~/.pi/agent` skips copying/pruning its own files.

Set `PI_LLAMA_CPP_URL=https://your-server/v1` when you explicitly want setup to
update the llama.cpp provider; it backs up `models.json` and preserves other
providers. Without a URL, existing model configuration is left alone, and fresh
installs start with an empty provider map. Secrets and `models.json` are not
committed. Setup never copies sessions, credentials, or local helper binaries.

**Restart Pi after this update**, rather than relying on `/reload`: older styled
output patches cannot restore their original methods. Future patches have
explicit reload/shutdown cleanup.

The optional `nono` profile is an external OS sandbox and is owned outside this
repository. Install it with `nono pull nolabs-ai/pi`; its own installer wires the
local package into Pi. Portable setup omits machine-local package references
when seeding settings. Merely loading its diagnostic extension does not sandbox
Pi: launch through your reviewed `nono run` profile to enforce OS restrictions.

Herdr is external too. The linked skill resolves to `~/.agents/skills/herdr`;
install it independently on a new machine. Setup leaves Herdr's managed
`extensions/herdr-agent-state.ts` to Herdr and skips the external skill symlink.
It does not overwrite registry-managed nono files or their diagnostic guidance.

## Tests and safety

```sh
npm test          # behavioral and source-contract tests; no model calls
npm run check     # JSON, JS/TS parsing, and shell syntax (not a typecheck)
git diff --check
```

Tests use disposable files/processes and a token-protected loopback HTTP server;
they do not install packages, publish changes, or use external services.

Pi permission and environment guardrails are tool-level controls, not a
complete filesystem or network sandbox. Review and approve an entire MCP script
before running it. Worker workflows are local-only by policy and do not push or
publish, but no documentation here promises a comprehensive OS-level
publishing guarantee. MCP gateway calls, scripts, and direct tools registered by
the adapter are gated. Script approval covers the entire script, not each nested
call; use adapter-level per-tool approvals or an outer sandbox for finer control.
The headless browser exception is limited to `chrome-devtools`, never auth actions.
Chrome DevTools MCP is pinned to the already-installed **1.7.0** release; review
and deliberately update this pin when upgrading.

Subagents default to Luna/high with parent-model fallback before any tool use.
`agents.defaults.timeoutSeconds` sets the per-task deadline (120 seconds by
default, including fallback attempts); increase it for longer implementation jobs.
Parallel batches allow at most eight tasks/four concurrent processes; chains at
most eight steps. Outputs are bounded and larger final reports spill to private
temporary files. Children retain the parent environment except coordinator
identity; use minimal/phantom credentials if environment isolation is required.

Project agents override same-named user agents only with explicit project scope;
collisions are reported. Headless project agents require a trusted project and
`confirmProjectAgents: false`. Global trusted skills/Pi docs have narrow read-only
resource exceptions; auth/session files do not. Browser provenance is a
trusted-process guardrail, not cryptographic isolation.

Firstmate is active only under its gated Herdr policy. It coordinates visible
workers; it does not implement locally. Read `extensions/firstmate/POLICY.md`
for authoritative lifecycle and reporting behavior.
