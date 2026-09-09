---
name: change-review
description: Review changes for bugs, risks, missing tests, and scope drift
---

# Change review

Use after implementation and before calling work complete.

## Role-aware review

- The `reviewer` agent is static and read-only: inspect diffs and relevant
  files, but do not build or run tests. Cite test evidence supplied by the main
  session or `unit-tester`, and mark tests `not run` when absent.
- The normal main session may run the relevant tests after review. Delegate test
  execution to `unit-tester` when that is clearer. A test failure or blocked
  test is evidence, not completion.

## Checklist

1. Restate the requested outcome, authority, scope/files, and acceptance
   criteria.
2. Read every changed file and inspect the diff for accidental extra changes.
3. Check behavior, edge cases, security/data exposure, maintainability, and
   missing tests. Distinguish verified defects from residual risk.
4. Confirm unrelated working-tree changes were preserved.
5. Report shared severity levels: P0 critical/security, P1 high impact, P2
   important, P3 minor polish.

```markdown
## Change Review
- **Intent:** one sentence
- **Verdict:** APPROVED | NEEDS CHANGES

### Findings
- [P0-P3] path/location — issue, impact, and evidence.
- None found in reviewed scope.

### Tests
- `command` — pass/fail/blocked/not run, with source of evidence

### Residual Risks
- Known gap or `None`
```
