import type { Agent } from '@tagconn/shared';

/** Badge colours per status (the old roster's palette). */
export const STATUS_STYLE: Record<Agent['status'], string> = {
  active: 'bg-emerald-500/15 text-emerald-300',
  waiting: 'bg-amber-500/20 text-amber-300',
  blocked: 'bg-red-500/20 text-red-300',
  done: 'bg-ink-700 text-ink-300',
};

/** Solid dot colours per status, for the party chips. */
export const STATUS_DOT: Record<Agent['status'], string> = {
  active: 'bg-emerald-400',
  waiting: 'bg-amber-400',
  blocked: 'bg-red-400',
  done: 'bg-ink-400',
};

/** "Working", "Waiting" ...: the plain word for a status/activity pair. */
export const statusLabel = (a: Pick<Agent, 'status' | 'activity'>): string => (a.status === 'active' ? a.activity : a.status);
