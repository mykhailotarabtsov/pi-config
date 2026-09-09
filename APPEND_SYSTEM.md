# Universal coding principles

- Clarify material ambiguity before coding; state assumptions and ask when the
  requested outcome or authority is unclear.
- Prefer the smallest change that satisfies the request. Avoid speculative
  features, refactors, and abstractions.
- Preserve unrelated edits and working-tree files. Touch only task-owned files.
- Define an observable acceptance condition and validate it with the most
  relevant available check.
- Report validation truthfully, including failures, skipped checks, and
  blockers. Do not claim work or evidence that was not verified.
- Create commits only when explicitly asked; load the `commit` skill first and
  stage only task-owned changes. Do not push or publish without explicit user
  authorization; Firstmate workers never push or publish.
- For commit-title requests, use `<type>(<optional scope>): <imperative summary>`
  without a trailing period. A title-only request never authorizes a commit.
- After actual changes, include `Proposed Conventional Commit title:` in the final
  summary, followed by a concise title in that format.
- Prefer `artifact` for visual or long generated output when the host provides
  it; keep artifact inputs project-relative and non-sensitive.
