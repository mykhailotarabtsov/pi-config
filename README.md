# pi-config

Pi agent configuration for easy setup across machines.

## What's in here

| File                   | Purpose                                                                |
| ---------------------- | ---------------------------------------------------------------------- |
| `settings.json`        | Default provider, model, theme, packages, extensions                   |
| `models.json.template` | Model providers with env var placeholders (never commit `models.json`) |
| `mcp.json`             | MCP server configurations                                              |
| `AGENTS.md`            | Main agent system prompt and behaviors                                 |
| `agents/*.md`          | Subagent definitions (official Pi extension format)                    |
| `prompts/*.md`         | Prompt templates for subagent workflows                                |
| `skills/*.md`          | Custom skill definitions (commit, change-review, learn-codebase, etc.) |
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

## What's excluded from git

These files are machine-specific and should never be committed:

```
auth.json      # Contains auth tokens
models.json    # Generated from template (contains local IPs)
sessions/      # Conversation history
mcp-cache.json / mcp-npx-cache.json  # Caches
.git/          # Cloned repo data
.DS_Store      # macOS junk
```

## Custom extensions

| Extension                           | Description                                                                                                                                                                                                                                     |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extensions/subagent/`              | Local subagent support based on Pi's official extension example. Registers the `subagent` tool and supports single, parallel, and chain delegation to `agents/*.md`.                                                                              |
| `extensions/permission-gate.ts`     | Codex-style session permission prompts for file edits/writes, unsafe bash commands, and MCP tool calls. Use `/permissions clear` to reset session trust.                                                                                         |
| `extensions/context-workflow.ts`    | Structured 5-stage dev workflow (write → test → review → fix → verify). Starts with `/workflow [spec]`, auto-progresses with deterministic test gates and context-compacted code review. (source - https://github.com/owainlewis/pi-extensions) |
| `extensions/fun-working-message.ts` | Replaces the default "Working..." status with a random message from a curated list each turn.                                                                                                                                                   |

## Updating configs

After pulling new config from this repo, always run:

```bash
./setup.sh
```

This regenerates `models.json` with your current environment variables, so if your server IP changes, it picks up the new value.
