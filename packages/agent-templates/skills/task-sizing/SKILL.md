---
name: task-sizing
description: Use when splitting a goal into a backlog of tasks for subagents - as an architect designing a task list, or as a PM before spawning a wave of subagents. Gives rules for sizing tasks so they run in 10-20 minutes, are owned by exactly one role, and can be parallelized without file conflicts.
---

# Task sizing rules

1. **10-20 minutes of work per task.** If a task feels bigger, split it. A subagent that runs much
   longer than this is usually doing two things, or discovering scope it should have surfaced as a
   separate task instead.
2. **One role owns each task.** A task is written for exactly one of: analyst, architect, developer,
   qa-engineer, code-reviewer, security-engineer, tech-writer. If a task needs two roles, it is two
   tasks with a dependency between them.
3. **File-disjoint for anything run in parallel.** Tasks scheduled in the same wave must not write
   to the same file. Two developers editing the same file in parallel is the #1 cause of lost work -
   split by module/feature/file instead, and if two tasks genuinely need the same file, sequence
   them (one depends on the other) rather than parallelizing.
4. **Contracts first.** Before splitting implementation work in parallel, the architect (or PM)
   writes the shared types/interfaces/schemas the parallel tasks will implement against. Developers
   build against the contract, not against each other's code. This is what makes disjoint-file
   parallelism safe.
5. **Explicit acceptance criteria.** Every task states what "done" looks like concretely enough that
   QA or the PM can verify it without re-reading the whole diff (see `definition-of-done`).
6. **Explicit dependencies.** If task B needs task A's output (a contract, a migration, an endpoint),
   say so. The PM sequences dependent tasks into separate waves; independent tasks go in the same
   wave.

## Examples

**Good split** (parallel, file-disjoint, contract-first):
- Task A (architect): define `packages/shared/src/widgets.ts` (types + zod schema). No dependency.
- Task B (developer, depends on A): implement `POST /api/widgets` in `apps/server/src/modules/widgets/`.
- Task C (developer, depends on A): implement the widgets list panel in `apps/web/src/features/widgets/`.
  B and C touch disjoint files and can run in the same wave once A lands.
- Task D (qa-engineer, depends on B+C): write an integration test exercising the endpoint and panel.

**Bad split** (too big, overlapping files, no contract):
- "Build the whole widgets feature" as one developer task - too big, hides the API contract decision
  inside implementation, can't be parallelized, and won't finish in 10-20 minutes.
- Two developers both told to "add widget support to the server" - both will likely touch
  `apps/server/src/main.ts` or the same route file and conflict.

## Using this as PM

When running the `office-kickoff` workflow, apply these rules when turning the architect's task list
into backlog rows, and again before spawning each wave: check that every task in the wave is
file-disjoint from every other task in the same wave.
