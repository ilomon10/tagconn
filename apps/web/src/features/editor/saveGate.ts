import { hasLayoutErrors, type LayoutIssue } from '@tagconn/shared';

/**
 * Save-blocking rule (guild-hall.md section 5, M8 8n reachability verifier). Pulled out of
 * `OfficeEditor` so it's unit-testable without rendering the modal:
 * - Any error (a genuinely unreachable room — blocked by furniture or no corridor, a `no-door`, a
 *   geometry problem, …) blocks saving outright; `canSaveLayout` mirrors the existing
 *   `!hasLayoutErrors(issues)` gate builtins already had, unchanged.
 * - A `room-sealed` warning (the user deliberately left `doors: []`) does NOT block saving, but the
 *   caller must get an explicit confirmation first — see `sealedRoomWarnings`.
 */
export function canSaveLayout(issues: readonly LayoutIssue[], builtin: boolean): boolean {
  return !builtin && !hasLayoutErrors(issues);
}

/** The `room-sealed` warnings among `issues` — when non-empty, `performSave` confirms before saving. */
export function sealedRoomWarnings(issues: readonly LayoutIssue[]): LayoutIssue[] {
  return issues.filter((i) => i.code === 'room-sealed');
}
