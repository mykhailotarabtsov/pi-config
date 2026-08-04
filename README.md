# pi-config

Pi agent configuration for easy setup across machines.

## What's in here

| File or directory      | Purpose                                                                |
| ---------------------- | ---------------------------------------------------------------------- |
| `settings.json`        | Default provider, model, theme, packages, and Pi settings              |
| `package.json`         | Pinned runtime dependencies for the artifacts extension                |
| `package-lock.json`    | Reproducible dependency lockfile                                      |
| `models.json.template` | Model providers with env var placeholders (never commit `models.json`) |
| `AGENTS.md`            | Pi-specific subagent and skill configuration                           |
| `APPEND_SYSTEM.md`     | Global coding principles appended to Pi's system prompt                |
| `agents/*.md`          | Subagent definitions used by the local subagent extension              |
| `prompts/*.md`         | Prompt templates, including implementation and handoff workflows       |
| `skills/*/SKILL.md`    | Custom skill definitions (commit, review, GitHub, and setup workflows) |
| `extensions/`          | Auto-discovered UI, workflow, permission, and subagent extensions      |
| `extensions/firstmate/` | Herdr-gated Firstmate coordination, session isolation, and task lifecycle |
| `tests/firstmate-delivery.test.mjs` | Focused delivery and teardown guard tests                  |
| `themes/`              | Pi themes, with `slop.json` currently selected                         |
| `bin/`                 | Helper binaries                                                        |
| `setup.sh`             | One-command restore script                                             |

## Environment variables

These are optional. Set them on machines where you want local providers configured (add to `~/.zshrc` or `~/.bashrc`):

```bash
# URL of your llama-cpp server (e.g., local machine or GPU server)
export PI_LLAMA_CPP_URL="http://192.168.0.XXX:8080/v1"

# URL of your ollama server (can be the same as llama-cpp)
export PI_OLLAMA_URL="http://192.168.0.XXX:11434/v1"
```

## Setup on a new machine

```bash
# 1. Clone this repo
git clone git@github.com:mykhailotarabtsov/pi-config.git ~/pi-config
cd ~/pi-config

# 2. Optional: set local provider environment variables (see above)
echo 'export PI_LLAMA_CPP_URL="http://192.168.0.XXX:8080/v1"' >> ~/.zshrc
echo 'export PI_OLLAMA_URL="http://192.168.0.XXX:11434/v1"' >> ~/.zshrc
source ~/.zshrc

# 3. Run the setup script
./setup.sh
```

This copies all config files into `~/.pi/agent/` and generates `models.json` from the template. If local provider environment variables are unset, their URL placeholders are left empty.

### Dry run

```bash
./setup.sh --dry-run
```

Shows what would be copied without making changes.

## Optional sandboxing with nono

[nono](https://nono.sh/) can run Pi with OS-enforced filesystem and network restrictions. Review the profile before using it:

```bash
brew install nono
nono pull nolabs-ai/pi
nono profile show nolabs-ai/pi

cd /path/to/project
nono run --profile nolabs-ai/pi -- pi
```

For convenience, add this alias to `~/.zshrc` (or `~/.bashrc`):

```bash
alias pi='nono run --profile nolabs-ai/pi -- pi'
```

Then reload the shell with `source ~/.zshrc`.

## Current UI and behavior

The configuration uses Pi's local auto-discovery for extensions, prompts, and
skills; `settings.json` does not need to list each local extension explicitly.
The active UI configuration includes:

- `themes/slop.json` as the active theme.
- A startup dashboard, styled transcript/tool output, boxed chat input, animated
  working status, a two-row footer, and safe browser artifacts.
- Hidden thinking blocks, quiet startup, tree view on double Escape, and disabled
  terminal progress.
- A permission gate for sensitive paths, out-of-project access, unsafe Bash
  commands, interactive `!`/`!!` commands, MCP calls, and headless subagents.
- Local subagent delegation through `extensions/subagent/` and the structured
  workflow extension in `extensions/context-workflow.ts`.

The Pikit UI and a hardened artifacts extension are included; web access, MCP
setup, plan/chat modes, and other non-UI modules are not. Artifacts default to
sanitized Markdown/static HTML, project-contained file inputs, and a
token-protected localhost server. The original project is available at
https://github.com/adrianapan/pikit. The old working-message extension remains
renamed to `fun-working-message.ts.disabled` so it does not conflict with the
new spinners extension.

## Herdr Firstmate workflow

The `extensions/firstmate/` extension is auto-discovered by Pi. It is active only
inside Herdr when `HERDR_ENV=1`; the first interactive Pi pane coordinates work,
while each worker runs as a visible Pi tab.

Firstmate uses a session-scoped worker isolation mode. The default is `shared`,
which starts the worker in the requested project checkout. Switch modes with:

```text
/firstmate-isolation shared
/firstmate-isolation worktree
```

The selection is persisted in the Pi session and applies to later `task_create`
calls. Shared-checkout tasks are already local, so they require only a structured
report and reconciliation before teardown. Worktree tasks use [Treehouse](https://github.com/kunchenguid/treehouse)
for isolated leases and follow this lifecycle:

```text
task_create -> worker structured report -> task_reconcile -> explicit task_deliver
(fast-forward landing) -> idempotent delivery retry if needed -> task_teardown
```

`task_reconcile` validates the worker's structured report. `task_deliver` is only
for worktree tasks and must explicitly land the worker branch with a local
fast-forward before cleanup; retry it idempotently if a delivery attempt needs to
be repeated. `task_teardown` verifies the exact task identity, closes the exact
worker tab, and returns the Treehouse lease when applicable. Do not manually close
worker tabs before cleanup.

Firstmate workers and their subagents cannot push or publish remote changes. The
permission gate hard-blocks `git push`, blocks MCP calls that could bypass this
rule, and Firstmate rejects push commands sent through `pane_run`.

Firstmate is inspired by [firstmate](https://github.com/kunchenguid/firstmate),
but this configuration ports only local-only delivery and teardown behavior,
not the full PR workflow.

For Firstmate changes, run the focused tests in
`tests/firstmate-delivery.test.mjs`, applicable Node syntax checks, and finish
with `git diff --check` plus link/path grep validation.

## Project-local session files

`/handoff` and `/pickup` use project-relative `.pi/handoffs/`; handoffs are
project-local documents. Artifact output uses project-relative `.pi/artifacts/`.
Generated `.pi/artifacts/` is excluded from git. These commands resolve paths
relative to the session cwd, so start Pi in the project or use an absolute
handoff path.

## What's excluded from git

These files are machine-specific and should never be committed:

```
auth.json      # Contains auth tokens
trust.json     # Machine-specific project trust decisions
models.json    # Generated from template (contains local IPs)
node_modules/  # Installed runtime dependencies
sessions/      # Conversation history
.pi/artifacts/ # Generated browser artifacts
mcp-cache.json / mcp-npx-cache.json  # Caches
.git/          # Cloned repo data
.DS_Store      # macOS junk
```

## Custom extensions

| Extension | Description |
| --- | --- |
| `extensions/styled-outputs/` | Styled assistant/user/thinking/tool transcript output, diffs, tool spinners, and `!`/`!!` command rendering. |
| `extensions/artifacts/` | Safe Markdown/static-HTML browser artifacts with diffs, code highlighting, optional pinned Mermaid, path restrictions, CSP, and a token-protected localhost server. |
| `extensions/footer/` | Two-row status footer with model, path, Git, context, token, and cost information. |
| `extensions/chat-input/` | Boxed, theme-aware chat editor with native history, autocomplete, and paste support. |
| `extensions/spinners/` | Animated working verbs with elapsed-time and token status. |
| `extensions/startup/` | Startup dashboard showing loaded resources and keyboard shortcuts. |
| `extensions/permission-gate.ts` | Allows ordinary in-project work while guarding protected paths, unsafe Bash, `!`/`!!` commands, MCP calls, and headless subagents. Use `/permissions clear` to reset session trust. |
| `extensions/subagent/` | Registers the `subagent` tool for single, parallel, and chained delegation to `agents/*.md`. |
| `extensions/context-workflow.ts` | Structured write → test → review → fix → verify workflow, started with `/workflow [spec]`. |
| `extensions/fun-working-message.ts.disabled` | Disabled because the Pikit spinners extension provides the working status without competing timers. |

## Updating configs

After pulling new config from this repo, always run:

```bash
./setup.sh
```

This regenerates `models.json` with your current environment variables and installs the pinned runtime dependencies from `package-lock.json`, so if your server IP changes, it picks up the new value.
