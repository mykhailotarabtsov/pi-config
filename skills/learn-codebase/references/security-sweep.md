# Security sweep cookbook

This is an optional, read-only workflow for concrete security and code-smell
checks. Tailor it to the repository and the active agent role; do not turn it
into a blanket audit.

1. Establish scope from the request and applicable instructions. Check tracked
   files and ignore generated, vendor, dependency, and test-only paths where
   appropriate.
2. Search for likely credentials, unsafe execution, injection, permissive
   network/security settings, and sensitive files. Prefer filename-only or
   redacted searches. Never print tokens, passwords, private-key contents, or
   full secret-bearing lines.
3. Inspect each candidate in context without exposing its value. Confirm a
   concrete path to impact before reporting it; do not report age or theory as
   a vulnerability.
4. Check dependency/configuration risks only when supported by repository
   evidence. A reviewer records them; an implementer changes them only when
   authorized and in scope; a scout reports them without editing.
5. Report findings as P0 critical, P1 high impact, P2 important, or P3 minor,
   with path, location, evidence type, impact, and a focused next step. Say
   `None found in the reviewed scope` when clean.

If commands are needed, use quiet/filename-only output and redact before sharing:

```sh
# Examples; adapt paths and tools to the repository.
git ls-files | grep -Ei '(^|/)(\.env|.*\.(pem|key|p12|pfx|jks|sqlite|db))$'
grep -RIlE 'api[_-]?key|secret|token|password|credential' . --exclude-dir=.git --exclude-dir=node_modules
grep -RInE '\beval\s*\(|dangerouslySetInnerHTML|child_process|rejectUnauthorized' . --exclude-dir=.git --exclude-dir=node_modules
```

These checks are guardrails for inspection, not a sandbox, and they do not
register MCP servers or external skills.
