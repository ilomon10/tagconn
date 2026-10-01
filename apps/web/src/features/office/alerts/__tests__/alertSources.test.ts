import { describe, expect, it } from 'vitest';
import type { Agent, OfficeEvent } from '@tagconn/shared';
import { alertsFromAgents, alertsFromEvents } from '../alertSources';
import { ALERT_LIMITS } from '../types';

const agent = (id: string, status: Agent['status'], projectId = 'p1'): Agent => ({ id, status, projectId }) as Agent;
const rec = (...a: Agent[]) => Object.fromEntries(a.map((x) => [x.id, x]));
const all = () => true;
const failure = (id: number, ts: number, over: Partial<OfficeEvent> = {}): OfficeEvent =>
  ({ id, ts, projectId: 'p1', sessionId: 's', agentId: 'a1', hookEvent: 'PostToolUseFailure', toolName: 'Bash', summary: '', ...over }) as OfficeEvent;

describe('alertsFromAgents', () => {
  it('raises ask for waiting and blocked, done for done, once per transition', () => {
    const prev = rec(agent('a', 'active'), agent('b', 'active'), agent('c', 'active'));
    const next = rec(agent('a', 'waiting'), agent('b', 'blocked'), agent('c', 'done'));
    const out = alertsFromAgents(prev, next, all, 100);
    expect(out).toEqual([
      { kind: 'ask', agentId: 'a', at: 100, key: 'waiting' },
      { kind: 'ask', agentId: 'b', at: 100, key: 'blocked' },
      { kind: 'done', agentId: 'c', at: 100, key: 'done' },
    ]);
    expect(alertsFromAgents(next, next, all, 200)).toEqual([]);
  });
  it('ignores agents first seen already in a status and non-alert transitions', () => {
    expect(alertsFromAgents({}, rec(agent('a', 'waiting')), all, 1)).toEqual([]);
    expect(alertsFromAgents(rec(agent('a', 'waiting')), rec(agent('a', 'active')), all, 1)).toEqual([]);
  });
  it('filters by floor', () => {
    const prev = rec(agent('a', 'active', 'p1'), agent('b', 'active', 'p2'));
    const next = rec(agent('a', 'waiting', 'p1'), agent('b', 'waiting', 'p2'));
    expect(alertsFromAgents(prev, next, (p) => p === 'p2', 1).map((i) => i.agentId)).toEqual(['b']);
  });
});

describe('alertsFromEvents', () => {
  const now = 100_000;
  it('only failures after afterId, and lastId advances past every event', () => {
    const evs = [failure(1, now), failure(2, now), failure(3, now, { hookEvent: 'PreToolUse' }), failure(4, now, { toolName: 'Edit' })];
    const r = alertsFromEvents(evs, 1, all, now);
    expect(r.inputs.map((i) => i.key)).toEqual(['Bash', 'Edit']);
    expect(r.inputs[0]).toMatchObject({ kind: 'failure', agentId: 'a1', toolName: 'Bash' });
    expect(r.lastId).toBe(4);
    expect(alertsFromEvents(evs, r.lastId, all, now)).toEqual({ inputs: [], lastId: 4 });
  });
  it('drops replayed old events but still advances lastId', () => {
    const r = alertsFromEvents([failure(9, now - ALERT_LIMITS.replayGraceMs - 1)], 0, all, now);
    expect(r).toEqual({ inputs: [], lastId: 9 });
  });
  it('filters by floor', () => {
    expect(alertsFromEvents([failure(1, now)], 0, () => false, now).inputs).toEqual([]);
  });
});
