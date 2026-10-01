// M13 alerts: turns store changes into queue inputs (docs/design/office-life.md 3.3.3). Pure.
import type { Agent, OfficeEvent } from '@tagconn/shared';
import { ALERT_LIMITS, type AlertInput } from './types';

/** ask: status became waiting|blocked (key = status). done: status became done (key 'done'). Only agents on the
 *  selected floor; no alert for agents first seen in `next` already in that status (snapshot / floor switch). */
export function alertsFromAgents(
  prev: Readonly<Record<string, Agent>>,
  next: Readonly<Record<string, Agent>>,
  onFloor: (projectId: string) => boolean,
  nowMs: number,
): AlertInput[] {
  const out: AlertInput[] = [];
  for (const agent of Object.values(next)) {
    const before = prev[agent.id];
    if (!before || before.status === agent.status || !onFloor(agent.projectId)) continue;
    if (agent.status === 'waiting' || agent.status === 'blocked') out.push({ kind: 'ask', agentId: agent.id, at: nowMs, key: agent.status });
    else if (agent.status === 'done') out.push({ kind: 'done', agentId: agent.id, at: nowMs, key: 'done' });
  }
  return out;
}

/** failure: events with id > afterId, hookEvent === 'PostToolUseFailure', on the floor, ts >= now - replayGraceMs. */
export function alertsFromEvents(
  events: readonly OfficeEvent[],
  afterId: number,
  onFloor: (projectId: string) => boolean,
  nowMs: number,
): { inputs: AlertInput[]; lastId: number } {
  const inputs: AlertInput[] = [];
  let lastId = afterId;
  for (const e of events) {
    if (e.id <= afterId) continue;
    lastId = Math.max(lastId, e.id);
    if (e.hookEvent !== 'PostToolUseFailure' || !onFloor(e.projectId) || e.ts < nowMs - ALERT_LIMITS.replayGraceMs) continue;
    inputs.push({ kind: 'failure', agentId: e.agentId, at: e.ts, key: e.toolName ?? 'tool', ...(e.toolName ? { toolName: e.toolName } : {}) });
  }
  return { inputs, lastId };
}

/** Stamps each input with the agent's snapshot (live store first, then the previous one) and drops inputs whose
 *  agent cannot be resolved, so a box never shows "unknown" with an empty portrait. */
export function withAgentSnapshots(
  inputs: readonly AlertInput[],
  ...lookups: ReadonlyArray<Readonly<Record<string, Agent>>>
): AlertInput[] {
  const out: AlertInput[] = [];
  for (const input of inputs) {
    const agent = lookups.map((l) => l[input.agentId]).find((a) => a !== undefined);
    if (agent) out.push({ ...input, agent });
  }
  return out;
}
