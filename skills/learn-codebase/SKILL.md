---
name: learn-codebase
description: Discover project conventions and surface concrete security concerns
---

# Learn the codebase

Use this skill when starting in an unfamiliar repository or when asked about
conventions or suspicious code. Start with the read-only tools `read`, `grep`,
`find`, and `ls`; use shell commands only when a repository fact requires them.

## Workflow

1. Locate root instructions (`AGENTS.md`, `CLAUDE.md`, `.cursor/`, `.pi/`, and
   related files) and read the applicable files fully.
2. Find project manifests, scripts, tests, and relevant source. Summarize the
   package manager, run/test commands, architecture, agent rules, and available
   skills without repeating boilerplate.
3. State the top few conventions that affect the requested work. Do not change
   code or settings as part of reconnaissance.
4. Run the optional security/smell workflow in
   [references/security-sweep.md](references/security-sweep.md) when requested
   or when the task makes it relevant. Adapt checks to the active role: a
   read-only scout reports evidence, an implementer fixes only in scope, and a
   reviewer records findings.
5. Never print secret values. Report only the path, kind, and necessary redacted
   evidence. Never auto-register discovered external skills; suggest them and
   wait for explicit approval.

## Output

### Project Conventions Summary

- **Build and test:** exact commands or `unknown`
- **Code style:** actionable rules
- **Architecture:** relevant structure
- **Agent rules:** applicable instructions
- **Available skills/commands:** relevant names and purpose

### Security and Code Smell Findings

Use shared severities P0 (critical), P1 (high impact), P2 (important), and P3
(minor). Say `None found in the reviewed scope` when the sweep is clean. Do not
flag theoretical issues, test-only patterns, or ordinary age without a concrete
risk.
