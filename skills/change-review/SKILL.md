---
name: change-review
description: "Review code changes for bugs, risks, and missing tests"
---

# Change Review

Review code changes before calling work complete.

## When to use

Use this skill when:
- A feature/fix is implemented and needs a quick quality check
- You want a focused review for regressions, risks, and missing tests
- You want to validate that the change matches the original request

## Review checklist

1. Understand intent
- Re-read the task/request in one sentence
- Confirm scope is clear

2. Inspect changed files
- Read all modified files fully
- Check for accidental extra changes

3. Validate behavior and risk
- Look for logic errors and edge-case misses
- Look for security and data-exposure risks
- Confirm error handling is explicit (fail fast over silent failures)

4. Verify tests
- Run the relevant test command(s)
- If no tests exist, state that clearly and propose minimal test coverage

5. Report findings by severity
- P0: production-breaking/security-critical
- P1: high-impact bug or reliability risk
- P2: important improvement
- P3: minor polish

## Output format

Use this structure:

```markdown
## Change Review
- **Intent:** <one sentence>
- **Verdict:** APPROVED | NEEDS CHANGES

### Findings
- [P1] <issue> - <file/path> - <why it matters>

### Tests
- `<command>`: pass/fail

### Residual Risks
- <known gaps or "none">
```

If there are no findings, explicitly say: `No issues found in reviewed scope.`
