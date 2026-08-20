## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it — don't delete it.

When your changes create orphans:
- Remove imports, variables, and functions that your changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then fix the code"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

## Commit titles and change summaries

- When a user asks for a commit message or title, use Conventional Commits format: `<type>(<optional scope>): <imperative summary>`. Keep the subject concise and do not end it with a period.
- A title-only request does not require a body and must not be treated as a request to create a commit. Create a full commit only when the user explicitly asks for one, following the applicable commit workflow.
- After making actual changes in a normal session, include a clearly labeled `Proposed Conventional Commit title:` in the final summary.

## 5. Visual Output → Artifacts

Keep visual or long output clear and concise. When output is inherently visual or
longer than a screen — reports, diagrams, rendered diffs, comparison tables —
prefer the `artifact` tool over printing a wall of text in the terminal.

- Use `kind: "markdown"` by default for prose, tables, diffs, and code.
- Mermaid fences are supported when enabled, using a pinned browser dependency.
- `kind: "html"` accepts only a static sanitized fragment; do not expect scripts,
  widgets, iframes, styles, or full HTML documents to work.
- File inputs must be relative, regular, non-sensitive files inside the project.
- Do not assume artifacts are a security sandbox; untrusted repositories still
  require normal review or a container/VM.
