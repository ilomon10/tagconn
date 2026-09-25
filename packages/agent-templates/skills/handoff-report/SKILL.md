---
name: handoff-report
description: Use whenever you finish (or get blocked on) a delegated task as a subagent in this "virtual software house" workflow - every subagent's final message must end with a ```handoff fenced block in this exact format so the PM (and the tagconn office UI) can parse status, files touched and next steps.
---

# Handoff report format

End your **final** reply with exactly one fenced block, using the literal language tag `handoff`:

```handoff
status: done | blocked | failed
summary: <one line>
files: <comma-separated paths changed, or none>
tests: <what you ran and the result, or none>
next: <role that should pick this up next, or none>
blockers: <what you need, or none>
```

Rules:
- The fence language must be `handoff` (not `text` or empty) - the office server and the PM both
  grep for that exact fence to extract the block.
- Fill every field, even when the answer is `none`. Do not omit a field.
- `status`:
  - `done` - the task is complete and meets its acceptance criteria.
  - `blocked` - you cannot proceed without something (a decision, a missing contract, access).
    Put exactly what you need in `blockers`.
  - `failed` - you attempted the task and it did not work (e.g. tests fail and you could not fix
    them in scope). Explain why in `summary`.
- `files`: real paths you created or edited, relative to the repo root. `none` if you only read code
  or only reported findings (e.g. code-reviewer, security-engineer).
- `tests`: the exact command(s) you ran and their result (pass/fail, counts). `none` is only
  acceptable when there is genuinely nothing to run yet.
- `next`: a role name (`analyst`, `architect`, `developer`, `qa-engineer`, `code-reviewer`,
  `security-engineer`, `tech-writer`) or `none` if nothing further is needed.
- `blockers`: concrete and actionable (e.g. "need the API contract for /api/widgets" - not "unclear
  requirements").
- Put the block at the very end of your message, after any other explanation. One block per reply.

## Why this matters

The office server parses `SubagentStop.last_assistant_message` for this block to update the task
board and the character's state in the 2D office (done/blocked/failed). A missing or malformed block
means the task silently stays "in progress" forever in the UI. When acting as PM, treat a reply
without a valid `handoff` block as incomplete and ask the subagent to restate it.
