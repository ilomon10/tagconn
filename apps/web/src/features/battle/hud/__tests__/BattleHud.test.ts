// The web package has no DOM test environment, so the HUD is checked as static markup (first render) plus its pure parts.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { HeroProgress } from '@tagconn/shared';
import { applyAction, createBattle, type BattleEvent, type BattleOutcome, type BattleResult, type HeroAward } from '@tagconn/shared';
import { setup } from '../../../../../../../packages/shared/src/battle/__tests__/fixtures';
import type { BattleController, BattleView, TimelineItem } from '../../../../game/battle/types';
import { applyDisplay, BattleHud, displayFromState, initialDisplay, type BattleHudProps } from '../BattleHud';
import { blipsBetween, visibleLog } from '../BattleLog';
import { hpTone } from '../Bar';
import { koNote, resultHeadline, resultSting, resultStages, ResultsPanel, xpBarPlan } from '../ResultsPanel';

const su = setup();
function fake(over: Partial<BattleView> = {}): BattleController {
  const state = createBattle(su);
  const view: BattleView = { setup: su, state, current: null, busy: false, lines: [], result: null, ...over };
  return { view: () => view, subscribe: () => () => {}, act: () => ({ ok: true }), tick: () => {}, skip: () => {}, actionLog: () => [], destroy: () => {} };
}
const item = (text: string, event: BattleEvent = { k: 'miss', by: { side: 'enemy' } }): TimelineItem => ({ seq: 1, event, text, durationMs: 500, startedAt: 0 });
const hud = (c: BattleController, p: Partial<BattleHudProps> = {}) =>
  renderToStaticMarkup(createElement(BattleHud, { controller: c, style: 'modern', reduced: false, phase: 'fighting', onContinue: () => {}, ...p }));

describe('BattleHud markup', () => {
  it('is a modal dialog that pauses app hotkeys', () => {
    const html = hud(fake());
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-label="Battle"');
    expect(html).toContain('data-modal="battle"');
  });
  it('labels the cards, bars and the command menu', () => {
    const html = hud(fake());
    expect(html).toContain('aria-label="Enemy: Production Bug, level 10"');
    expect(html).toContain('aria-label="Dev, level 10"');
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuetext="60 of 60"');
    expect(html).toContain('aria-label="FOCUS"');
    expect(html).toContain('role="menu"');
    expect(html).toContain('aria-label="Battle commands"');
    for (const l of ['Fight', 'Skill', 'Item', 'Swap', 'Run']) expect(html).toContain(`aria-label="${l}"`);
    expect(html).toContain('data-sfx="none"'); // sounds come from the reducer, not the delegate
    expect(html).toContain('aria-activedescendant');
  });
  it('lists the bench with a fainted/alive label', () => {
    expect(hud(fake())).toContain('aria-label="QA, 60 of 60 HP"');
  });
  it('puts every played line in a polite live log', () => {
    const html = hud(fake({ lines: ['Dev used Commit!', 'It hits.'] }));
    expect(html).toMatch(/<ul role="log"[^>]*aria-live="polite"[^>]*class="sr-only"/);
    expect(html).toContain('<li>Dev used Commit!</li>');
    expect(html).toContain('<li>It hits.</li>');
  });
  it('types the current line (nothing yet on the first frame) but shows it whole under reduced motion', () => {
    const lines = ['Monster used Segfault!'];
    const c = fake({ lines, current: item(lines[0]!), busy: true });
    expect(hud(c)).toContain('<span aria-hidden="true"></span>');
    const r = hud(c, { reduced: true });
    expect(r).toContain('<span aria-hidden="true">Monster used Segfault!</span>');
    expect(r).not.toContain('inline-block h-3 w-1.5'); // no caret
  });
  it('tells a busy player they can skip, and dims the menu', () => {
    const html = hud(fake({ busy: true, current: item('') }));
    expect(html).toContain('Enter to skip');
    expect(html).toContain('aria-busy="true"');
  });
  it('shows no commands in the results phase', () => {
    const html = hud(fake({ result: 'won' }), { phase: 'resolving' });
    expect(html).not.toContain('role="menu"');
    expect(html).toContain('Recording the battle');
    expect(html).toContain('Victory!');
  });
});

describe('display model', () => {
  it('starts from the engine state and moves one played event at a time', () => {
    let d = initialDisplay(su);
    expect(d).toMatchObject({ hp: [60, 60], focus: [40, 40], enemyHp: 90, active: 0 });
    d = applyDisplay(d, { k: 'damage', target: { side: 'enemy' }, amount: 20, hp: 70, eff: 'normal', crit: false, selfHit: false });
    d = applyDisplay(d, { k: 'damage', target: { side: 'party', index: 1 }, amount: 5, hp: 55, eff: 'normal', crit: false, selfHit: false });
    d = applyDisplay(d, { k: 'focus', target: { side: 'party', index: 0 }, amount: -8, focus: 32 });
    d = applyDisplay(d, { k: 'swap', from: 0, to: 1, forced: false });
    expect(d).toMatchObject({ enemyHp: 70, hp: [60, 55], focus: [32, 40], active: 1 });
    expect(applyDisplay(d, { k: 'use', by: { side: 'enemy' }, move: 0 })).toBe(d);
  });
  it('the final display equals the engine state after replaying every event', () => {
    const s0 = createBattle(su);
    const r = applyAction(su, s0, { t: 'move', move: 0 });
    if (!r.ok) throw new Error(r.error);
    expect(r.events.reduce(applyDisplay, displayFromState(s0))).toEqual(displayFromState(r.state));
  });
});

describe('bar and log helpers', () => {
  it('colours: green > 50 %, amber > 20 %, red below', () => {
    expect([hpTone(60, 100), hpTone(50, 100), hpTone(21, 100), hpTone(20, 100), hpTone(0, 100)]).toEqual(['ok', 'warn', 'warn', 'low', 'low']);
  });
  it('blips every third character', () => {
    expect(blipsBetween(0, 2)).toBe(0);
    expect(blipsBetween(2, 3)).toBe(1);
    expect(blipsBetween(0, 9)).toBe(3);
    expect(blipsBetween(9, 9)).toBe(0);
  });
  it('visibleLog separates the live line from the scrollback', () => {
    expect(visibleLog(['a', 'b', 'c'], 'c')).toEqual({ older: ['a', 'b'], live: 'c' });
    expect(visibleLog(['a', 'b', 'c', 'd', 'e'], 'e').older).toEqual(['c', 'd']);
    expect(visibleLog(['a', 'b'], null)).toEqual({ older: ['a', 'b'], live: null });
  });
});

const award = (o: Partial<HeroAward> = {}): HeroAward => ({ heroId: 'h1', memberIndex: 0, xpGained: 40, levelBefore: 3, levelAfter: 3, skillPointsGained: 0, fainted: false, koUntil: null, ...o });
const outcome = (o: Partial<BattleOutcome> = {}): BattleOutcome => ({ battleId: 'b1', result: 'won', turns: 4, heroes: [award()], loot: null, resolvedAt: 1_000_000, ...o });
const panel = (o: BattleOutcome | null, result: BattleResult, extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(ResultsPanel, { setup: su, style: 'modern', result, phase: o ? 'results' : 'resolving', outcome: o, reduced: false, onContinue: () => {}, ...extra }));

describe('ResultsPanel', () => {
  it('has a headline for every result', () => {
    expect(resultHeadline('won', 'Wolf')).toBe('Victory!');
    expect(resultHeadline('lost', 'Wolf')).toBe('Defeated…');
    expect(resultHeadline('fled', 'Wolf')).toBe('Got away safely');
    expect(resultHeadline('timeout', 'Wolf')).toBe('Wolf lost interest');
    expect([resultSting('won'), resultSting('lost'), resultSting('fled'), resultSting('timeout')]).toEqual(['battle-victory', 'battle-defeat', null, null]);
  });
  it('renders each result with Continue', () => {
    for (const [r, text] of [['won', 'Victory!'], ['lost', 'Defeated…'], ['fled', 'Got away safely'], ['timeout', 'Production Bug lost interest']] as const) {
      const html = panel(outcome({ result: r }), r);
      expect(html).toContain(text);
      expect(html).toContain('Continue');
      expect(html).toContain('+40 XP');
    }
  });
  it('shows level-ups with skill points and the loot card', () => {
    const html = panel(outcome({ heroes: [award({ levelBefore: 11, levelAfter: 12, skillPointsGained: 1 })], loot: { heroId: 'h1', lootId: 'hardhat' as never } }), 'won', { onOpenHero: () => {} });
    expect(html).toContain('Level up! 11 → 12');
    expect(html).toContain('+1 skill point');
    expect(html).toContain('🎁');
    expect(html).toContain('for Dev');
    expect(html).toContain('Open hero sheet');
  });
  it('reduced motion reveals everything at once and drops the transitions', () => {
    const html = panel(outcome({ heroes: [award({ levelBefore: 1, levelAfter: 2, skillPointsGained: 1 })], loot: { heroId: 'h1', lootId: 'hardhat' as never } }), 'won', { reduced: true });
    expect(html).toContain('scaleX(1)');
    expect(html).not.toContain('opacity-0');
    expect(html).toContain('Lv 2');
  });
  it('KO notes, stages', () => {
    expect(koNote({ fainted: false, koUntil: null }, 0)).toBeNull();
    expect(koNote({ fainted: true, koUntil: 5 * 60_000 }, 0)).toBe('💫 resting 5 min');
    expect(koNote({ fainted: true, koUntil: null }, 0)).toBe('🩹 keeps working');
    expect(panel(outcome({ heroes: [award({ fainted: true, koUntil: 1_000_000 + 300_000 })] }), 'lost')).toContain('resting 5 min');
    expect(resultStages(outcome())).toEqual({ xp: true, levelUp: false, loot: false });
    expect(resultStages(outcome({ heroes: [award({ xpGained: 0 })] })).xp).toBe(false);
  });
  it('error phase shows the message and Close', () => {
    const html = panel(null, 'won', { phase: 'error', error: 'Server said no' });
    expect(html).toContain('role="alert"');
    expect(html).toContain('Server said no');
    expect(html).toContain('Close');
  });
});

describe('xpBarPlan', () => {
  const prog = (o: Partial<HeroProgress> = {}): HeroProgress => ({ heroId: 'h1', projectId: 'p', classId: 'engineer', xp: 150, level: 3, levelXp: 100, nextLevelXp: 200, skillPoints: 0, bonusPoints: 0, skills: {}, overspent: false, koUntil: null, wins: 0, losses: 0, flees: 0, loot: [], equippedTitle: null, updatedAt: 2_000_000, ...o }) as HeroProgress;
  const a = { xpGained: 40, levelBefore: 3, levelAfter: 3 };
  it('falls back to the gain meter without progress', () => {
    expect(xpBarPlan(a, undefined, 1_000_000)).toEqual({ kind: 'gain' });
  });
  it('uses the post-award value', () => {
    const p = xpBarPlan(a, prog(), 1_000_000);
    expect(p).toMatchObject({ kind: 'progress', to: 0.5, wrapped: false, maxed: false });
    expect((p as { from: number }).from).toBeCloseTo(0.1);
  });
  it('adds the award to a stale value, and gives up when that would cross a level', () => {
    const stale = prog({ updatedAt: 1, xp: 110 });
    expect(xpBarPlan(a, stale, 1_000_000)).toMatchObject({ kind: 'progress', to: 0.5 });
    expect(xpBarPlan({ ...a, xpGained: 95 }, stale, 1_000_000)).toEqual({ kind: 'gain' });
    expect(xpBarPlan({ ...a, levelAfter: 4 }, stale, 1_000_000)).toEqual({ kind: 'gain' });
  });
  it('wraps on a level-up and ignores a mismatched level', () => {
    expect(xpBarPlan({ xpGained: 90, levelBefore: 2, levelAfter: 3 }, prog({ xp: 120 }), 1_000_000)).toEqual({ kind: 'progress', from: 0, to: 0.2, wrapped: true, maxed: false });
    expect(xpBarPlan({ xpGained: 90, levelBefore: 2, levelAfter: 4 }, prog(), 1_000_000)).toEqual({ kind: 'gain' });
  });
  it('is full at max level', () => {
    expect(xpBarPlan(a, prog({ nextLevelXp: null }), 1_000_000)).toMatchObject({ to: 1, from: 1, maxed: true });
  });
  it('renders real progress in the panel', () => {
    const html = panel(outcome(), 'won', { progressByHero: { h1: prog() } });
    expect(html).toContain('40 XP gained, 50% to the next level');
  });
});
