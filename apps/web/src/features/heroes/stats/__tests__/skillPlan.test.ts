import { describe, expect, it } from 'vitest';
import { SKILL_TREES } from '@tagconn/shared';
import { apply, canAdd, classifySaveError, describeCheck, canRemove, canRespec, checkPlan, nodeStatus, planFrom, pointsLeft, rankIn, sameAllocation, type PlanCtx } from '../skillPlan';

const tree = SKILL_TREES.developer;
const ctx = (over: Partial<PlanCtx> = {}): PlanCtx => ({
  tree,
  saved: {},
  level: 10,
  totalPoints: 9,
  allowRespec: true,
  ...over,
});
const label = (n: { id: string }) => n.id;

describe('skillPlan', () => {
  it('planFrom copies into a null-prototype record', () => {
    const saved = { 'developer.0.1': 2 };
    const p = planFrom({ skills: saved });
    expect(p).toEqual(saved);
    expect(p).not.toBe(saved);
    expect(Object.getPrototypeOf(p)).toBeNull();
    expect(rankIn(p, 'constructor')).toBe(0);
  });

  it('adds a rank, counts points, and stops at maxRank', () => {
    let p = planFrom({ skills: {} });
    for (let i = 0; i < 5; i++) p = apply(p, { type: 'add', id: 'developer.0.1' }, ctx());
    expect(rankIn(p, 'developer.0.1')).toBe(5);
    expect(pointsLeft(p, 9)).toBe(4);
    const sixth = apply(p, { type: 'add', id: 'developer.0.1' }, ctx());
    expect(sixth).toBe(p);
    expect(canAdd(p, 'developer.0.1', ctx())).toMatchObject({
      ok: false,
      code: 'rank-out-of-range',
    });
  });

  it('rejects a missing prerequisite', () => {
    const p = planFrom({ skills: {} });
    expect(canAdd(p, 'developer.0.2', ctx())).toMatchObject({
      ok: false,
      code: 'missing-prerequisite',
    });
    expect(apply(p, { type: 'add', id: 'developer.0.2' }, ctx())).toBe(p);
    const withT1 = apply(p, { type: 'add', id: 'developer.0.1' }, ctx());
    expect(canAdd(withT1, 'developer.0.2', ctx()).ok).toBe(true);
  });

  it('rejects a tier whose level is not reached', () => {
    const p = { 'developer.0.1': 1, 'developer.0.2': 1 };
    expect(canAdd(p, 'developer.0.3', ctx({ level: 5 }))).toMatchObject({
      ok: false,
      code: 'level-too-low',
    });
    expect(canAdd(p, 'developer.0.3', ctx({ level: 8 })).ok).toBe(true);
  });

  it('rejects spending beyond the points', () => {
    const p = { 'developer.0.1': 2 };
    expect(canAdd(p, 'developer.1.1', ctx({ totalPoints: 2 }))).toMatchObject({
      ok: false,
      code: 'not-enough-points',
    });
  });

  it('refuses a removal that would orphan a dependent rank', () => {
    const p = { 'developer.0.1': 1, 'developer.0.2': 1 };
    expect(canRemove(p, 'developer.0.1', ctx())).toMatchObject({
      ok: false,
      code: 'missing-prerequisite',
    });
    expect(apply(p, { type: 'remove', id: 'developer.0.1' }, ctx())).toBe(p);
    const q = apply(p, { type: 'remove', id: 'developer.0.2' }, ctx());
    expect(canRemove(q, 'developer.0.1', ctx()).ok).toBe(true);
  });

  it('allows lowering a rank above the one stored, but not below it without respec', () => {
    const saved = { 'developer.0.1': 2 };
    const c = ctx({ saved, allowRespec: false });
    let p = planFrom({ skills: saved });
    p = apply(p, { type: 'add', id: 'developer.0.1' }, c);
    expect(canRemove(p, 'developer.0.1', c).ok).toBe(true); // 3 -> 2, still the saved rank
    p = apply(p, { type: 'remove', id: 'developer.0.1' }, c);
    expect(canRemove(p, 'developer.0.1', c)).toMatchObject({
      ok: false,
      code: 'respec-disabled',
    });
    expect(canRespec(c)).toBe(false);
    expect(apply(p, { type: 'clear' }, c)).toBe(p);
  });

  it('lets an overspent stored plan be reduced and cleared even when respec is off', () => {
    const saved = { 'developer.0.1': 5 };
    const c = ctx({ saved, allowRespec: false, totalPoints: 3 });
    expect(canRespec(c)).toBe(true);
    expect(canRemove(saved, 'developer.0.1', c).ok).toBe(true);
    const cleared = apply(saved, { type: 'clear' }, c);
    expect(Object.keys(cleared)).toEqual([]);
    expect(checkPlan(cleared, c).ok).toBe(true);
  });

  it('clear and reset replace the plan; sameAllocation compares by rank', () => {
    const c = ctx({ saved: { 'developer.0.1': 1 } });
    const cleared = apply({ 'developer.0.1': 1 }, { type: 'clear' }, c);
    expect(sameAllocation(cleared, {})).toBe(true);
    const back = apply(cleared, { type: 'reset', to: c.saved }, c);
    expect(sameAllocation(back, c.saved)).toBe(true);
    expect(sameAllocation({ 'developer.0.1': 1 }, { 'developer.0.1': 2 })).toBe(false);
  });

  it('ignores prototype keys', () => {
    const p = planFrom({ skills: {} });
    expect(canAdd(p, '__proto__', ctx())).toMatchObject({
      ok: false,
      code: 'unknown-skill',
    });
    expect(canRemove(p, 'constructor', ctx())).toMatchObject({
      ok: false,
      code: 'unknown-skill',
    });
  });

  it('classifies node states with reasons', () => {
    const c = ctx({ level: 3, totalPoints: 2 });
    const node = (id: string) => tree.nodes.find((n) => n.id === id)!;
    const p = { 'developer.0.1': 1 };
    expect(nodeStatus(p, node('developer.0.1'), c, label).state).toBe('owned');
    expect(nodeStatus(p, node('developer.0.2'), c, label).state).toBe('available');
    const locked = nodeStatus(p, node('developer.0.3'), c, label);
    expect(locked.state).toBe('locked');
    expect(locked.addBlock).toBe('Needs developer.0.2 first');
    expect(nodeStatus({}, node('developer.1.3'), c, label).addBlock).toContain('Needs');
    expect(nodeStatus({ 'developer.0.1': 1, 'developer.0.2': 1 }, node('developer.0.3'), c, label).addBlock).toBe('Unlocks at level 8');
    expect(nodeStatus({ 'developer.0.1': 5 }, node('developer.0.1'), c, label).state).toBe('maxed');
    expect(nodeStatus({ 'developer.0.1': 1, 'developer.0.2': 1 }, node('developer.0.1'), c, label).removeBlock).toBe('A later skill depends on this one');
  });

  it('classifies a stale-base save as a conflict', () => {
    expect(classifySaveError(new Error('Progress for "h-1" was changed since you loaded it')).kind).toBe('conflict');
    expect(classifySaveError(new Error('Battles are disabled')).kind).toBe('other');
  });

  it('describes a failed check in words', () => {
    expect(describeCheck({ ok: false, code: 'level-too-low', skillId: 'developer.0.3' }, tree)).toBe('developer.0.3 unlocks at level 8');
    expect(describeCheck({ ok: true }, tree)).toBe('');
  });
});
