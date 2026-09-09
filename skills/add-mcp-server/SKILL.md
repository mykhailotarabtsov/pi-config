---
name: add-mcp-server
description: Add or configure an MCP server for Pi
---

# Add an MCP server

Determine scope before editing:

- Global: `~/.pi/agent/mcp.json`
- Project-local: `.pi/mcp.json`

Project-local configuration is for one repository; global configuration is for
servers shared across projects. Read the existing file, preserve other servers,
and ask before replacing a same-named server.

## Configuration

Use stdio or HTTP. Keep examples version-pinned without inventing the version
that the parent/root configuration has selected:

```json
{
  "mcpServers": {
    "server-name": {
      "command": "npx",
      "args": ["-y", "package-name@<pinned-version>"],
      "env": { "API_KEY": "<environment-variable-reference>" }
    }
  }
}
```

For HTTP, prefer an environment reference rather than a literal bearer secret:

```json
{
  "mcpServers": {
    "server-name": {
      "url": "https://example.invalid/mcp",
      "auth": "bearer",
      "bearerTokenEnv": "MCP_SERVER_TOKEN"
    }
  }
}
```

Use only fields supported by the installed adapter. For this configuration,
manual browser QA uses the deliberately configured `chrome-devtools` server;
do not silently substitute another server or an unpinned version. The
root/parent config owns the selected package version.

## Apply and verify deliberately

1. Confirm the requested server, scope, command/URL, pinned version, and
   environment variable names. Do not ask users to paste secret values into
   chat or config.
2. Merge the server into the chosen JSON file and review the diff.
3. Reload Pi deliberately after the edit. MCP/script execution is guarded as a
   whole script; review and approve the complete script rather than assuming
   individual calls are safe.
4. If authentication is required, have the human perform it manually. Never
   automate sign-in or handle credentials.
5. Connect to the named server and list tools only after approval. Report the
   exact result or the concrete blocker.
