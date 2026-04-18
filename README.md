# pi-config

Pi agent configuration for easy setup across machines.

## What's in here

| File                   | Purpose                                                                |
| ---------------------- | ---------------------------------------------------------------------- |
| `settings.json`        | Default provider, model, theme, packages, extensions                   |
| `models.json.template` | Model providers with env var placeholders (never commit `models.json`) |
| `mcp.json`             | MCP server configurations                                              |
| `AGENTS.md`            | Main agent system prompt and behaviors                                 |
| `agents/*.md`          | Subagent definitions (builder, unit-tester, browser-tester)            |
| `skills/*.md`          | Custom skill definitions (commit, change-review, learn-codebase, etc.) |
| `bin/`                 | Helper binaries                                                        |
| `setup.sh`             | One-command restore script                                             |

## Environment variables

These must be set on each machine (add to `~/.zshrc` or `~/.bashrc`):

```bash
# URL of your llama-cpp server (e.g., local machine or GPU server)
export PI_LLAMA_CPP_URL="http://192.168.0.XXX:8080/v1"

# URL of your ollama server (can be the same as llama-cpp)
export PI_OLLAMA_URL="http://192.168.0.XXX:11434/v1"
```

## Setup on a new machine

```bash
# 1. Clone this repo
git clone git@github.com:<your-username>/pi-config.git ~/pi-config
cd ~/pi-config

# 2. Set environment variables (see above)
echo 'export PI_LLAMA_CPP_URL="http://192.168.0.XXX:8080/v1"' >> ~/.zshrc
echo 'export PI_OLLAMA_URL="http://192.168.0.XXX:11434/v1"' >> ~/.zshrc
source ~/.zshrc

# 3. Run the setup script
./setup.sh
```

This copies all config files into `~/.pi/agent/` and generates `models.json` from the template with your actual server URLs.

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
| `extensions/context-workflow.ts`    | Structured 5-stage dev workflow (write → test → review → fix → verify). Starts with `/workflow [spec]`, auto-progresses with deterministic test gates and context-compacted code review. (source - https://github.com/owainlewis/pi-extensions) |
| `extensions/fun-working-message.ts` | Replaces the default "Working..." status with a random message from a curated list each turn.                                                                                                                                                   |

## Updating configs

After pulling new config from this repo, always run:

```bash
./setup.sh
```

This regenerates `models.json` with your current environment variables, so if your server IP changes, it picks up the new value.
