import { describe, expect, it } from 'vitest';
import type { Agent, Hero, HeroProgress } from '@tagconn/shared';
import { candidateSource, formatKoTimer, partyCandidates } from '../party';

const NOW = 1_000_000;
const settings = (anonymousInBattle: boolean) => ({ progression: { anonymousInBattle, xpWeights: { output: 1, input: 0.2, cacheCreation: 0.1, cacheRead: 0 }, levelBase: 1500, levelExponent: 2, maxLevel: 50 } }) as never;

const hero = (id: string, name: string, over: Partial<Hero> = {}): Hero =>
  ({ id, projectId: 'p', role: 'developer', slot: 0, name, boundAgentId: null, releasedAt: null, ...over }) as Hero;
const agent = (id: string, over: Partial<Agent> = {}): Agent =>
  ({ id, projectId: 'p', role: 'qa', status: 'active', activity: 'idle', ...over }) as Agent;
const prog = (heroId: string, level: number, koUntil: number | null = null): HeroProgress =>
  ({ heroId, projectId: 'p', classId: 'developer', level, skills: {}, koUntil }) as unknown as HeroProgress;

const map = <T extends { id: string }>(xs: T[]): Record<string, T> => Object.fromEntries(xs.map((x) => [x.id, x]));

describe('partyCandidates', () => {
  it('lists the floor heroes only, with level and a positive max HP', () => {
    const heroes = map([hero('h-00000001', 'Ada'), hero('h-00000002', 'Bo', { projectId: 'other' })]);
    const out = partyCandidates(heroes, {}, { 'h-00000001': prog('h-00000001', 7) }, settings(true), 'p', NOW);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ key: 'h-00000001', ref: { kind: 'hero', heroId: 'h-00000001' }, level: 7, temporary: false, selectable: true, working: false });
    expect(out[0]!.maxHp).toBeGreaterThan(0);
  });

  it('tags a hero whose bound agent is active and not idle as working', () => {
    const heroes = map([hero('h-00000001', 'Ada', { boundAgentId: 'a1' }), hero('h-00000002', 'Bo', { boundAgentId: 'a2' })]);
    const agents = map([agent('a1', { activity: 'coding' as never }), agent('a2', { activity: 'idle' })]);
    const out = partyCandidates(heroes, agents, {}, settings(false), 'p', NOW);
    expect(out.find((c) => c.key === 'h-00000001')!.working).toBe(true);
    expect(out.find((c) => c.key === 'h-00000002')!.working).toBe(false);
  });

  it('keeps a KO hero unselectable with its timer, and a recovered one selectable', () => {
    const heroes = map([hero('h-00000001', 'Ada'), hero('h-00000002', 'Bo')]);
    const progress = { 'h-00000001': prog('h-00000001', 9, NOW + 60_000), 'h-00000002': prog('h-00000002', 3, NOW - 1) };
    const out = partyCandidates(heroes, {}, progress, settings(false), 'p', NOW);
    const ko = out.find((c) => c.key === 'h-00000001')!;
    expect(ko).toMatchObject({ selectable: false, koUntil: NOW + 60_000 });
    expect(out.find((c) => c.key === 'h-00000002')).toMatchObject({ selectable: true, koUntil: null });
  });

  it('sanitizes and clips an anonymous agent name, falling back to the role', () => {
    const agents = map([agent('a2', { description: 'x\u202Ey'.repeat(40) }), agent('a3', { description: '   ' })]);
    const out = partyCandidates({}, agents, {}, settings(true), 'p', NOW);
    const long = out.find((c) => c.key === 'agent:a2')!;
    expect(Array.from(long.name).length).toBeLessThanOrEqual(40);
    expect(long.name).not.toContain('\u202E');
    expect(out.find((c) => c.key === 'agent:a3')!.name).toBe('qa');
  });

  it('adds live unbound agents as temporary members only when the setting is on', () => {
    const heroes = map([hero('h-00000001', 'Ada', { boundAgentId: 'a1' })]);
    const agents = map([agent('a1'), agent('a2'), agent('a3', { status: 'done' }), agent('a4', { projectId: 'other' })]);
    expect(partyCandidates(heroes, agents, {}, settings(false), 'p', NOW).map((c) => c.key)).toEqual(['h-00000001']);
    const on = partyCandidates(heroes, agents, {}, settings(true), 'p', NOW);
    expect(on.map((c) => c.key).sort()).toEqual(['agent:a2', 'h-00000001']);
    expect(on.find((c) => c.key === 'agent:a2')).toMatchObject({ temporary: true, ref: { kind: 'agent', agentId: 'a2' }, selectable: true });
  });

  it('gives an anonymous agent a temporary level from its usage', () => {
    const usage = { inputTokens: 0, outputTokens: 24_000, cacheReadTokens: 0, cacheCreationTokens: 0 };
    const out = partyCandidates({}, map([agent('a2', { usage: usage as never })]), {}, settings(true), 'p', NOW);
    expect(out[0]!.level).toBe(5);
  });

  it('orders selectable first, then level descending, then name', () => {
    const heroes = map([hero('h-00000001', 'Zed'), hero('h-00000002', 'Amy'), hero('h-00000003', 'Cy'), hero('h-00000004', 'Dax')]);
    const progress = {
      'h-00000001': prog('h-00000001', 5),
      'h-00000002': prog('h-00000002', 5),
      'h-00000003': prog('h-00000003', 20, NOW + 1000),
      'h-00000004': prog('h-00000004', 8),
    };
    expect(partyCandidates(heroes, {}, progress, settings(false), 'p', NOW).map((c) => c.name)).toEqual(['Dax', 'Amy', 'Zed', 'Cy']);
  });

  it('resolves hostile keys safely', () => {
    expect(candidateSource('constructor', Object.create(null), Object.create(null))).toBeNull();
    expect(candidateSource('agent:__proto__', Object.create(null), Object.create(null))).toBeNull();
  });
});

describe('formatKoTimer', () => {
  it('formats m:ss, rounding up and clamping at zero', () => {
    expect(formatKoTimer(NOW + 252_000, NOW)).toBe('4:12');
    expect(formatKoTimer(NOW + 1, NOW)).toBe('0:01');
    expect(formatKoTimer(NOW - 5, NOW)).toBe('0:00');
  });
});
