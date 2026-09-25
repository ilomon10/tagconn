---
name: definition-of-done
description: Use before marking any backlog item or task "done" - as the PM closing out a task, as a developer about to write a handoff report, or as a reviewer/QA deciding whether to sign off. Gives the checklist a task must pass to be truly done, not just "code written".
---

# Definition of done

A task is **done** only when every item below is true. If any item is false, the status is
`blocked` or `failed` (see the `handoff-report` skill), never `done`.

1. **Acceptance criteria met, with evidence.** Each criterion from the backlog/task description is
   satisfied. State how you verified it (a command run, an output, a screenshot description) - not
   just "should work".
2. **Tests added and passing.** New behavior has a test; changed behavior's existing tests still
   pass. Include the exact command and its result. "none" is only acceptable when the task is
   genuinely untestable (e.g. a doc-only change) - say why.
3. **Typecheck and lint are clean.** Run the project's typecheck/lint commands (e.g.
   `pnpm --filter <pkg> typecheck`) for every package you touched. No new errors, even pre-existing
   ones you introduced by accident.
4. **Reviewed.** A `code-reviewer` (and, for anything touching auth/input/secrets/network, a
   `security-engineer`) has looked at the diff and their findings are resolved or explicitly
   deferred with the PM's sign-off.
5. **No open high-severity security findings.** Medium/low findings may be deferred with a reason;
   high/critical findings block "done".
6. **Docs updated when behavior changed.** README, CLAUDE.md, architecture docs, or inline comments
   reflect the new behavior if a user- or developer-facing behavior changed.
7. **Backlog updated.** `.office/backlog.md` (or the tracker in use) reflects the final status, and
   the task's `handoff` block is accurate.

## Using this as a checklist

Before writing your `handoff` block, walk items 1-7 in order. If you skip one, say so explicitly in
`summary` or `blockers` rather than silently marking `done`. A PM running the `office-kickoff`
workflow should re-check this list in the verification wave before reporting to the user.
