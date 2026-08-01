# artifacts

Creates safe browser artifacts for reports, tables, rendered diffs, code blocks,
and optional Mermaid diagrams.

## Safety model

- Markdown is the preferred input. Raw HTML in Markdown is sanitized.
- `kind: "html"` accepts only a static HTML fragment; scripts, styles, event
  handlers, iframes, external images, unsafe URLs, and full documents are removed
  or rejected.
- Mermaid uses the pinned local `@mermaid-js/tiny@11.16.0` asset, served through
  the authenticated localhost server. Mermaid's strict security mode remains
  enabled. Set `mermaid: false` to render Mermaid fences as ordinary code blocks.
- File inputs must be relative regular UTF-8 files inside the project. Absolute
  paths, traversal, symlinks, sensitive files, and files over 2 MB are rejected.
- Artifacts are stored in `.pi/artifacts/` and served only on `127.0.0.1` through
  a random per-session token. Browser pages bootstrap an HttpOnly cookie and remove
the token from history; displayed URLs are session-local. The server rejects
traversal, symlinked files, malformed URLs, non-GET requests, and missing/invalid tokens.
- Browser opening is disabled for headless sessions.

## Tool actions

- `create`: write a new artifact and open it by default in an interactive session; an existing slug is rejected.
- `update`: overwrite an existing artifact and live-reload an already-open page.
- `open`: open an existing artifact in the browser.
- `list`: list generated artifacts without starting the server.

Storage is generated output. Add `.pi/artifacts/` to a project's `.gitignore`.

## Configuration

```bash
cp ~/.pi/agent/extensions/artifacts/artifacts.example.json \
  ~/.pi/agent/configs/artifacts.json
```

All fields are optional: `theme` (`auto`, `light`, or `dark`), `accent`,
`accentLight`, `maxWidth`, and `mermaid`.
