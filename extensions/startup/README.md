# startup

A startup header for the pi coding agent. Displays a three-column welcome box at session start showing the pi logo, loaded configuration counts, and quick keyboard shortcuts.

<img alt="preview" src="https://github.com/user-attachments/assets/18d9730b-7df1-48a5-b91e-404454bcb06f" />

## Features

- **Pi logo**: ASCII art rendered in the accent colour
- **Loaded counts**: Reports runtime-proven counts for active model, extension commands, skills, and prompt templates; host metadata is omitted when unavailable
- **Quick tips**: Inline keyboard shortcut reminders
- **Version banner**: Agent version shown in the top border
- **Responsive layout**: Box adapts to terminal width; hidden below 44 columns
- **Nerd Font icons**: Uses Nerd Font glyphs where available, falls back to plain Unicode symbols automatically

## What it shows

| Column | Content |
|--------|---------|
| Left | Pi ASCII art logo |
| Centre | Runtime-proven counts for active model, extension commands, skills, prompt templates, and optional context metadata |
| Right | Keyboard shortcuts |

## Loaded counts discovery

The extension uses Pi runtime metadata where available. It counts skills, prompt templates, and extension commands from `pi.getCommands()` provenance, and only displays active-model/context metadata supplied by the host. It intentionally does not duplicate Pi's loader to guess ancestor overrides, local paths, package filters, models, or MCP server counts.

The legacy exported count helpers remain available for focused compatibility tests, but are not used to render the dashboard:

| Type | Source |
|------|--------|
| Active model | `ctx.model` at session start |
| Extension commands | `pi.getCommands()` entries with `source: "extension"` |
| Skills | `pi.getCommands()` entries with `source: "skill"` |
| Prompt templates | `pi.getCommands()` entries with `source: "prompt"` |
| Context files | Omitted at startup unless supplied by host metadata |

## Icons

Nerd Font icons are auto-detected from your terminal. Ghostty, WezTerm, Kitty, iTerm2, and Alacritty are recognised automatically — everything else falls back to plain Unicode symbols. If detection gets it wrong (e.g. when running inside tmux), override it:

```bash
export FOOTER_NERD_FONTS=1  # force Nerd Fonts on
export FOOTER_NERD_FONTS=0  # force plain icons
```

### Installing a Nerd Font (macOS)

```bash
brew install --cask font-jetbrains-mono-nerd-font
```

Other fonts available via `brew search nerd-font`.

### Configuring iTerm2

1. Open **Settings → Profiles → Text**
2. Set **Font** to `JetBrainsMonoNL Nerd Font Propo`, size `10` (recommended)
3. Enable **Use a different font for non-ASCII text** and set the same font there — required for icons to render correctly
