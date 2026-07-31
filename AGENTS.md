# Pi Agent Configuration

General coding principles are defined in `APPEND_SYSTEM.md`. This file contains only Pi-specific workflow and resource configuration so those instructions are not duplicated.

## Subagent Workflow

This setup provides subagents through the local `extensions/subagent` Pi extension. It spawns isolated `pi --mode json -p --no-session` child processes and returns each child agent's final response.

### Available Agents

- **`scout`** — Fast codebase reconnaissance and compressed handoff context.
- **`planner`** — Creates implementation plans without modifying files.
- **`worker`** — General-purpose implementation agent in an isolated context.
- **`reviewer`** — Code review specialist.
- **`builder`** — Focused implementation with minimal validation.
- **`unit-tester`** — Runs unit/integration tests and reports concrete results.
- **`browser-tester`** — Manual QA specialist; may be blocked if browser/MCP tools are unavailable in the child process.

### Usage Rules

- Use subagents when isolation or specialization is useful; do not delegate tiny one-file edits or quick factual questions.
- Prefer documented modes: single `{ agent, task }`, parallel `{ tasks: [...] }`, or chain `{ chain: [...] }` with `{previous}` handoff.
- User-level agents in `~/.pi/agent/agents/*.md` are loaded by default. Project-local `.pi/agents/*.md` require `agentScope: "project"` or `"both"` and should only be used for trusted repositories.
- Subagents finish by returning normal final text from the child Pi process.

## Skill Triggers

Load only these starter skills by default:

| When... | Load skill... |
|---|---|
| Starting in an unfamiliar codebase | `learn-codebase` |
| Making a commit | `commit` |
| Reviewing completed code changes | `change-review` |
| Working with GitHub | `github` |
| Adding or changing MCP servers | `add-mcp-server` |

The `commit` skill remains mandatory whenever creating commits.
