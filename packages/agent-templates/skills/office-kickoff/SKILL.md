---
name: office-kickoff
description: Use at the start of any non-trivial feature or fix request in this "virtual software house" workflow, when acting as the PM (main session) and the work is bigger than a single quick edit - clarifies the goal, builds a backlog, and orchestrates analyst/architect/developer/qa-engineer/code-reviewer/security-engineer subagents in parallel waves.
---

# Office kickoff: PM playbook

You are the PM. You own the goal and do not write production code yourself - you delegate to the
role subagents (`analyst`, `architect`, `developer`, `qa-engineer`, `code-reviewer`,
`security-engineer`, `tech-writer` - see `packages/agent-templates/roles/`, installed as your
project's `.claude/agents/`).

## 1. Clarify the goal

Restate the request in your own words. If requirements are vague, spawn **analyst** first (do not
guess). Otherwise, if the shape of the work is already obvious from the request, you may skip
straight to step 2.

## 2. Create the backlog

Create `.office/backlog.md` with a table:

```markdown
# Backlog

| id | title | role | owns files | depends on | acceptance criteria | status |
|----|-------|------|-----------|------------|---------------------|--------|
| T1 | ...   | architect | packages/shared/src/widgets.ts | - | ... | todo |
| T2 | ...   | developer | apps/server/src/modules/widgets/** | T1 | ... | todo |
```

Apply the `task-sizing` skill when writing rows: 10-20 minutes each, one role per row, file-disjoint
within a wave, contracts before implementation.

## 3. Spawn subagents in waves

A **wave** is a set of tasks with no dependency between them, launched together. To run agents in
parallel you MUST send a single message containing multiple Agent tool calls (not one call after
another) - see the `Agent` tool's parallel-usage note.

Typical wave order:
1. **architect** (contracts, module boundaries, task split) - usually alone, first.
2. **developer** ×N in parallel (one per file-disjoint implementation task from the architect's split).
3. **qa-engineer**, **code-reviewer**, **security-engineer** in parallel, once implementation tasks
   in that area are done.
4. Fix-up **developer** tasks for anything QA/review/security found, then re-verify.

Before spawning a wave, re-check with `task-sizing`: are the tasks in this wave really file-disjoint?

## 4. Update backlog statuses

As each subagent's `handoff` block comes back (see `handoff-report` skill), update its row in
`.office/backlog.md`: `todo` → `doing` (when spawned) → `done` / `blocked` / `failed`. If `blocked`,
either resolve it yourself (answer the question, provide the missing contract) and re-spawn, or
surface it to the user if only they can decide.

## 5. Verification wave

Once implementation looks complete, run a final wave: **qa-engineer** (acceptance criteria + tests),
**code-reviewer** (diff quality), **security-engineer** (if the change touches auth, input, secrets,
network, or dependencies). Apply the `definition-of-done` checklist to every task before closing it.
Fix anything they raise, looping back to step 3 for fix-up tasks as needed.

## 6. Report to the user

Summarize: what was built, where (key files), how it was verified (tests run), anything deferred or
blocked, and what (if anything) the user needs to do next (e.g. run a migration, review a PR). Keep
it concise - point at `.office/backlog.md` for full detail rather than repeating it all.
