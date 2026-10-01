import { describe, expect, it } from 'vitest';
import { SettingsSchema, type Agent } from '@tagconn/shared';
import { dismissAlert, initialAlertQueue, offerAlert, tickAlerts } from '../alertQueue';
import { ALERT_LIMITS } from '../types';
import type { AlertInput, AlertKind, AlertSettings } from '../types';

const base: AlertSettings = SettingsSchema.parse({}).office.alerts;
const cfg = (o: Partial<AlertSettings> = {}): AlertSettings => ({ ...base, ...o });
const inp = (agentId: string, kind: AlertKind = 'ask', key: string = kind, at = 0): AlertInput => ({ kind, agentId, key, at });
const W = ALERT_LIMITS.coalesceMs;

describe('alertQueue', () => {
  it('keeps the offer-time agent snapshot on the item, merged when coalesced', () => {
    const c = cfg({ agentCooldownSec: 0 });
    const a = { id: 'a', role: 'developer' } as Agent;
    const b = { id: 'b', role: 'qa-engineer' } as Agent;
    let s = initialAlertQueue(c, 0);
    s = offerAlert(s, { ...inp('a', 'done'), agent: a }, c, 0);
    s = offerAlert(s, { ...inp('b', 'done'), agent: b }, c, 10);
    expect(s.pending[0]?.agents).toEqual({ a, b });
  });

  it('burst then refill at perMinute', () => {
    const c = cfg({ burst: 2, perMinute: 6, maxVisible: 5, agentCooldownSec: 0, autoDismissSec: 0 });
    let s = initialAlertQueue(c, 0);
    // distinct kinds so nothing coalesces
    s = offerAlert(s, inp('a', 'ask'), c, 0);
    s = offerAlert(s, inp('b', 'failure', 'Bash'), c, 0);
    s = offerAlert(s, inp('c', 'done'), c, 0);
    let r = tickAlerts(s, c, W, false);
    expect(r.shown.map((i) => i.kind)).toEqual(['ask', 'failure']);
    expect(r.state.pending).toHaveLength(1);
    r = tickAlerts(r.state, c, W + 5_000, false); // 0.5 token
    expect(r.shown).toHaveLength(0);
    r = tickAlerts(r.state, c, W + 10_000, false); // 1 token
    expect(r.shown.map((i) => i.kind)).toEqual(['done']);
  });

  it('shows by priority ask > failure > done, then oldest', () => {
    const c = cfg({ maxVisible: 5, agentCooldownSec: 0 });
    let s = initialAlertQueue(c, 0);
    s = offerAlert(s, inp('a', 'done'), c, 0);
    s = offerAlert(s, inp('b', 'failure', 'T'), c, 10);
    s = offerAlert(s, inp('c', 'ask'), c, 20);
    expect(tickAlerts(s, c, 20 + W, false).shown.map((i) => i.kind)).toEqual(['ask', 'failure', 'done']);
  });

  it('same-agent offers coalesce while pending; a repeat after the item shows alerts again', () => {
    const c = cfg({ agentCooldownSec: 60 });
    let s = initialAlertQueue(c, 0);
    s = offerAlert(s, inp('a', 'ask', 'waiting'), c, 0);
    s = offerAlert(s, inp('a', 'ask', 'waiting'), c, 100);
    expect(s.pending).toHaveLength(1);
    s = tickAlerts(s, c, W, false).state;
    // waiting -> active -> waiting after the cooldown: alerts a second time
    s = offerAlert(s, inp('a', 'ask', 'waiting'), c, 61_000 + W);
    expect(s.pending).toHaveLength(1);
    expect(tickAlerts(s, c, 61_000 + 2 * W, false).shown).toHaveLength(1);
  });

  it('two failures of the same tool alert twice (after the cooldown)', () => {
    const c = cfg({ agentCooldownSec: 60, maxVisible: 5 });
    let s = initialAlertQueue(c, 0);
    s = offerAlert(s, inp('a', 'failure', 'Bash'), c, 0);
    let r = tickAlerts(s, c, W, false);
    expect(r.shown).toHaveLength(1);
    s = offerAlert(r.state, inp('a', 'failure', 'Bash'), c, 70_000);
    r = tickAlerts(s, c, 70_000 + W, false);
    expect(r.shown).toHaveLength(1);
  });

  it('prunes lastShown entries past the cooldown', () => {
    const c = cfg({ agentCooldownSec: 10 });
    let s = initialAlertQueue(c, 0);
    s = offerAlert(s, inp('a', 'done'), c, 0);
    s = tickAlerts(s, c, W, false).state;
    expect(Object.keys(s.lastShown)).toEqual(['a']);
    s = tickAlerts(s, c, W + 11_000, false).state;
    expect(s.lastShown).toEqual({});
  });

  it('coalescing failures of different tools drops the single toolName', () => {
    const c = cfg({ agentCooldownSec: 0 });
    let s = initialAlertQueue(c, 0);
    s = offerAlert(s, inp('a', 'failure', 'Bash'), { ...c }, 0);
    s = offerAlert(s, { ...inp('b', 'failure', 'Edit'), toolName: 'Edit' }, c, 10);
    expect(s.pending[0]?.toolName).toBeUndefined();
  });

  it('drops when disabled or kind off', () => {
    let s = initialAlertQueue(base, 0);
    s = offerAlert(s, inp('a'), cfg({ enabled: false }), 0);
    expect(s.pending).toHaveLength(0);
    s = offerAlert(s, inp('b', 'done'), cfg({ onDone: false }), 0);
    expect(s.pending).toHaveLength(0);
  });

  it('cooldown blocks same/lower priority but not higher', () => {
    const c = cfg({ agentCooldownSec: 60, maxVisible: 5 });
    let s = initialAlertQueue(c, 0);
    s = offerAlert(s, inp('a', 'failure', 'T'), c, 0);
    s = tickAlerts(s, c, W, false).state;
    s = offerAlert(s, inp('a', 'done'), c, 5_000);
    s = offerAlert(s, inp('a', 'failure', 'U'), c, 5_000);
    expect(s.pending).toHaveLength(0);
    s = offerAlert(s, inp('a', 'ask'), c, 5_000);
    expect(s.pending).toHaveLength(1);
    s = tickAlerts(s, c, 5_000 + W, false).state;
    s = offerAlert(s, inp('a', 'done', 'done2'), c, 70_000 + W);
    expect(s.pending).toHaveLength(1);
  });

  it('coalesces within the window, dedupes agent ids, shows one item', () => {
    const c = cfg({ agentCooldownSec: 0 });
    let s = initialAlertQueue(c, 0);
    s = offerAlert(s, inp('a'), c, 0);
    s = offerAlert(s, inp('b'), c, 500);
    s = offerAlert(s, inp('a', 'ask', 'blocked'), c, 600);
    expect(s.pending).toHaveLength(1);
    expect(s.pending[0]!.agentIds).toEqual(['a', 'b']);
    expect(tickAlerts(s, c, 500, false).shown).toHaveLength(0); // window not passed
    const r = tickAlerts(s, c, W, false);
    expect(r.shown).toHaveLength(1);
    expect(r.shown[0]!.agentIds).toEqual(['a', 'b']);
    // outside the window: new item
    s = offerAlert(initialAlertQueue(c, 0), inp('a'), c, 0);
    s = offerAlert(s, inp('b'), c, W + 1);
    expect(s.pending).toHaveLength(2);
  });

  it('caps pending (drops lowest priority, oldest) and expires by TTL', () => {
    const c = cfg({ agentCooldownSec: 0 });
    let s = initialAlertQueue(c, 0);
    s = offerAlert(s, inp('d0', 'done'), c, 0);
    for (let i = 0; i < ALERT_LIMITS.pendingMax; i++) s = offerAlert(s, inp('f' + i, 'failure', 'T' + i), c, (i + 1) * 2 * W);
    expect(s.pending).toHaveLength(ALERT_LIMITS.pendingMax);
    expect(s.pending.some((p) => p.kind === 'done')).toBe(false);
    const r = tickAlerts(s, cfg({ burst: 1 }), 400_000, false);
    expect(r.shown).toHaveLength(0);
    expect(r.state.pending).toHaveLength(0);
  });

  it('hidden clears pending and shows nothing', () => {
    const c = cfg();
    let s = offerAlert(initialAlertQueue(c, 0), inp('a'), c, 0);
    const r = tickAlerts(s, c, W, true);
    expect(r.shown).toHaveLength(0);
    expect(r.state.pending).toHaveLength(0);
  });

  it('autoDismiss expires visible; 0 keeps them', () => {
    const c = cfg({ autoDismissSec: 8 });
    let s = offerAlert(initialAlertQueue(c, 0), inp('a'), c, 0);
    s = tickAlerts(s, c, W, false).state;
    expect(s.visible).toHaveLength(1);
    expect(tickAlerts(s, c, W + 7_000, false).state.visible).toHaveLength(1);
    expect(tickAlerts(s, c, W + 8_000, false).state.visible).toHaveLength(0);
    expect(tickAlerts(s, cfg({ autoDismissSec: 0 }), W + 999_000, false).state.visible).toHaveLength(1);
  });

  it('respects maxVisible and dismissAlert frees a slot', () => {
    const c = cfg({ maxVisible: 1, burst: 5, agentCooldownSec: 0, autoDismissSec: 0 });
    let s = initialAlertQueue(c, 0);
    s = offerAlert(s, inp('a', 'ask'), c, 0);
    s = offerAlert(s, inp('b', 'done'), c, 0);
    let r = tickAlerts(s, c, W, false);
    expect(r.shown.map((i) => i.kind)).toEqual(['ask']);
    expect(tickAlerts(r.state, c, W + 100, false).shown).toHaveLength(0);
    const id = r.state.visible[0]!.id;
    s = dismissAlert(r.state, id);
    expect(s.visible).toHaveLength(0);
    expect(dismissAlert(s, 'nope')).toBe(s);
    r = tickAlerts(s, c, W + 200, false);
    expect(r.shown.map((i) => i.kind)).toEqual(['done']);
  });
});
