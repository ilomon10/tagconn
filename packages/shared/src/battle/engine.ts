/**
 * Battle engine (M14, docs/design/battles.md 1.6). Pure, deterministic, integer maths: no ambient randomness or clock,
 * no floating point in the rules. The only entropy is `state.rng` (mulberry32, see rng.ts).
 *
 * DRAW ORDER (fixed; any change bumps ENGINE_VERSION and the golden test). One `choose` action consumes, in order:
 *   a. enemy intent, only if the enemy is not stunned: r1 (category), r2 (move within the category);
 *   b. action order, only for two competing moves with equal priority and SPD: r3 (even = party first);
 *   c. per actor: merge-conflict confusion draw (< 33 of % 100 = self-hit, the action is lost);
 *   d. per move: accuracy (if < 100), then per hit crit then spread, then (after the last hit) status chance, status
 *      resist (only if the target has statusResistPct > 0) and duration (only if turns[0] < turns[1]);
 *   e. run: one draw.
 * Events: `start` once (first action), `turn` at the start of every `choose` action. A battle that ends mid-turn also
 * advances `turn`, so `turns = state.turn - 1` is the number of turns played. A stunned combatant skips exactly one
 * action (the skip clears it; stun is not decremented at the end of the turn).
 */
import { rngNext, seedState } from './rng.js';
import {
  ENGINE_VERSION,
  typeEffect,
  type ApplyResult,
  type BattleEvent,
  type BattleResult,
  type BattleSetup,
  type BattleState,
  type CombatantSetup,
  type CombatantState,
  type Effectiveness,
  type PlayerAction,
  type ReplayResult,
  type Side,
} from './types.js';
import type { MoveDef } from '../progression.js';

export { rngNext, seedState } from './rng.js';

const START_SALT = 0x9e3779b9;
const BASE_CRIT_PCT = 6;
const BASE_FOCUS_REGEN = 2;
const CONFUSE_PCT = 33;
const SELF_HIT_POWER = 30;

const PARTY = (index: number): Side => ({ side: 'party', index });
const ENEMY: Side = { side: 'enemy' };

export function createBattle(setup: BattleSetup): BattleState {
  return {
    engineVersion: setup.engineVersion,
    rng: seedState(setup.seed, START_SALT),
    turn: 1,
    phase: 'choose',
    active: 0,
    party: setup.party.map((c) => ({ hp: c.stats.hp, focus: c.stats.focus, status: null, statusTurns: 0, buffTurns: 0, shieldTurns: 0, fainted: false })),
    enemy: { hp: setup.enemy.stats.hp, focus: setup.enemy.stats.focus, status: null, statusTurns: 0, buffTurns: 0, shieldTurns: 0, fainted: false },
    items: setup.items.map((i) => i.count),
    runAttempts: 0,
    actions: 0,
    result: null,
  };
}

function cloneState(s: BattleState): BattleState {
  return { ...s, party: s.party.map((p) => ({ ...p })), enemy: { ...s.enemy }, items: [...s.items] };
}

const alive = (p: CombatantState | undefined): p is CombatantState => !!p && !p.fainted;

export function legalActions(setup: BattleSetup, s: BattleState): PlayerAction[] {
  if (s.phase === 'ended') return [];
  const out: PlayerAction[] = [];
  const swaps: PlayerAction[] = [];
  s.party.forEach((p, i) => {
    if (!p.fainted && i !== s.active) swaps.push({ t: 'swap', to: i });
  });
  if (s.phase === 'forced-swap') return swaps;
  const me = s.party[s.active];
  if (!me) return [];
  setup.party[s.active]?.moves.forEach((m, i) => {
    if (me.focus >= m.focusCost) out.push({ t: 'move', move: i });
  });
  setup.items.forEach((it, i) => {
    if ((s.items[i] ?? 0) <= 0) return;
    out.push({ t: 'item', item: i });
    if (it.def.effect === 'heal-party') return;
    s.party.forEach((p, ti) => {
      if (!p.fainted && ti !== s.active) out.push({ t: 'item', item: i, target: ti });
    });
  });
  out.push(...swaps, { t: 'run' });
  return out;
}

// ------------------------------------------------------------------ damage maths

function baseDamage(level: number, power: number, atk: number, def: number): number {
  const d = Math.max(1, def);
  return Math.floor(Math.floor((Math.floor((2 * level) / 5) + 2) * power * atk / d) / 50) + 2;
}

const effOf = (mult: number): Effectiveness => (mult > 1000 ? 'super' : mult < 1000 ? 'weak' : 'normal');

interface DamageIn { attacker: CombatantSetup; atkState: CombatantState; defender: CombatantSetup; defState: CombatantState; move: Pick<MoveDef, 'type' | 'power'>; crit: boolean; spread: number }
function computeDamage(i: DamageIn): { amount: number; eff: Effectiveness } {
  const atk = i.atkState.buffTurns > 0 ? Math.floor((i.attacker.stats.atk * 3) / 2) : i.attacker.stats.atk;
  let dmg = baseDamage(i.attacker.level, i.move.power, atk, i.defender.stats.def);
  if (i.move.type !== 'neutral' && i.move.type === i.attacker.type) dmg = Math.floor((dmg * (1250 + i.attacker.mods.typeBoostPct * 10)) / 1000);
  const mult = i.move.type === 'neutral' ? 1000 : typeEffect(i.move.type, i.defender.type);
  dmg = Math.floor((dmg * mult) / 1000);
  if (i.crit) dmg = Math.floor((dmg * 1500) / 1000);
  dmg = Math.floor((dmg * i.spread) / 100);
  if (i.defState.shieldTurns > 0) dmg = Math.floor((dmg * 500) / 1000);
  return { amount: Math.max(1, dmg), eff: effOf(mult) };
}

export function damagePreview(setup: BattleSetup, s: BattleState, move: number): { min: number; max: number; eff: Effectiveness } | null {
  const me = setup.party[s.active];
  const meState = s.party[s.active];
  const mv = me?.moves[move];
  if (!me || !meState || !mv || mv.category !== 'attack' || mv.power <= 0) return null;
  const mk = (spread: number) => computeDamage({ attacker: me, atkState: meState, defender: setup.enemy, defState: s.enemy, move: mv, crit: false, spread });
  const lo = mk(85);
  return { min: lo.amount * mv.hits, max: mk(100).amount * mv.hits, eff: lo.eff };
}

// ------------------------------------------------------------------ context

class Ctx {
  readonly s: BattleState;
  readonly events: BattleEvent[] = [];
  constructor(readonly setup: BattleSetup, s: BattleState) { this.s = cloneState(s); }
  draw(): number {
    const r = rngNext(this.s.rng);
    this.s.rng = r.state;
    return r.value;
  }
  emit(e: BattleEvent): void { this.events.push(e); }
  get over(): boolean { return this.s.phase === 'ended'; }
  cs(side: Side): CombatantSetup { return side.side === 'enemy' ? this.setup.enemy : (this.setup.party[side.index] as CombatantSetup); }
  st(side: Side): CombatantState { return side.side === 'enemy' ? this.s.enemy : (this.s.party[side.index] as CombatantState); }
  opponent(side: Side): Side { return side.side === 'enemy' ? PARTY(this.s.active) : ENEMY; }
  finish(result: BattleResult): void {
    if (this.over) return;
    this.s.phase = 'ended';
    this.s.result = result;
    this.emit({ k: 'end', result });
  }
  /** Marks `side` fainted when its HP is 0 and settles the battle if that decides it. */
  checkFaint(side: Side): void {
    const c = this.st(side);
    if (c.hp > 0 || c.fainted) return;
    c.hp = 0;
    c.fainted = true;
    c.buffTurns = 0;
    c.shieldTurns = 0;
    this.emit({ k: 'faint', target: side });
    if (side.side === 'enemy') this.finish('won');
    else if (!this.s.party.some((p) => !p.fainted)) this.finish('lost');
  }
  damage(target: Side, amount: number, eff: Effectiveness, crit: boolean, selfHit: boolean): void {
    const c = this.st(target);
    c.hp = Math.max(0, c.hp - amount);
    this.emit({ k: 'damage', target, amount, hp: c.hp, eff, crit, selfHit });
    this.checkFaint(target);
  }
  heal(target: Side, amount: number): void {
    const c = this.st(target);
    const gained = Math.max(0, Math.min(this.cs(target).stats.hp - c.hp, amount));
    c.hp += gained;
    this.emit({ k: 'heal', target, amount: gained, hp: c.hp });
  }
  clearStatus(target: Side): void {
    const c = this.st(target);
    if (c.status === null) return;
    const old = c.status;
    c.status = null;
    c.statusTurns = 0;
    this.emit({ k: 'status', target, status: old, on: false });
  }
  setTimed(target: Side, kind: 'buffed' | 'shielded', turns: number): void {
    const c = this.st(target);
    if (kind === 'buffed') c.buffTurns = turns;
    else c.shieldTurns = turns;
    this.emit({ k: 'status', target, status: kind, on: true });
  }
  clearTimed(target: Side): void {
    const c = this.st(target);
    if (c.buffTurns > 0) this.emit({ k: 'status', target, status: 'buffed', on: false });
    if (c.shieldTurns > 0) this.emit({ k: 'status', target, status: 'shielded', on: false });
    c.buffTurns = 0;
    c.shieldTurns = 0;
  }
}

// ------------------------------------------------------------------ moves

function useMove(ctx: Ctx, by: Side, moveIndex: number, mv: MoveDef): void {
  const me = ctx.cs(by);
  const meState = ctx.st(by);
  const target = ctx.opponent(by);
  ctx.emit({ k: 'use', by, move: moveIndex });
  if (by.side === 'party' && mv.focusCost > 0) {
    meState.focus -= mv.focusCost;
    ctx.emit({ k: 'focus', target: by, amount: -mv.focusCost, focus: meState.focus });
  }
  if (mv.accuracy < 100 && ctx.draw() % 100 >= mv.accuracy) {
    ctx.emit({ k: 'miss', by });
    return;
  }
  if (mv.target === 'enemy') {
    const def = ctx.cs(target);
    const defState = ctx.st(target);
    if (mv.category === 'attack' && mv.power > 0) {
      for (let h = 0; h < mv.hits && !ctx.over; h++) {
        const crit = ctx.draw() % 100 < BASE_CRIT_PCT + me.mods.critPct + mv.critBonusPct;
        const spread = 85 + (ctx.draw() % 16);
        const d = computeDamage({ attacker: me, atkState: meState, defender: def, defState, move: mv, crit, spread });
        ctx.damage(target, d.amount, d.eff, crit, false);
        if (defState.fainted) break;
      }
    }
    if (mv.status && !ctx.over && !defState.fainted && defState.status === null) {
      if (ctx.draw() % 100 < mv.status.chancePct) {
        if (def.mods.statusResistPct > 0 && ctx.draw() % 100 < def.mods.statusResistPct) {
          ctx.emit({ k: 'resisted', target, status: mv.status.id });
        } else {
          const [lo, hi] = mv.status.turns;
          const turns = lo < hi ? lo + (ctx.draw() % (hi - lo + 1)) : lo;
          defState.status = mv.status.id;
          defState.statusTurns = turns;
          ctx.emit({ k: 'status', target, status: mv.status.id, on: true });
        }
      }
    }
  }
  if (ctx.over) return;
  if (mv.self) {
    if (mv.self.id === 'burnout') {
      if (meState.status === null) {
        meState.status = 'burnout';
        meState.statusTurns = mv.self.turns;
        ctx.emit({ k: 'status', target: by, status: 'burnout', on: true });
      }
    } else ctx.setTimed(by, mv.self.id, mv.self.turns);
  }
  if (mv.healPct > 0) {
    const amount = (maxHp: number) => Math.floor((maxHp * mv.healPct * (100 + me.mods.healBoostPct)) / 10000);
    if (mv.target === 'party' && by.side === 'party') {
      ctx.s.party.forEach((p, i) => {
        if (!p.fainted) ctx.heal(PARTY(i), amount(ctx.cs(PARTY(i)).stats.hp));
      });
    } else ctx.heal(by, amount(me.stats.hp));
  }
  if (mv.cure) ctx.clearStatus(by);
}

// ------------------------------------------------------------------ enemy AI

function chooseEnemyMove(ctx: Ctx): number {
  const e = ctx.setup.enemy;
  const es = ctx.s.enemy;
  const hero = ctx.s.party[ctx.s.active] as CombatantState;
  const heroSetup = ctx.cs(PARTY(ctx.s.active));
  const attack: number[] = [];
  const status: number[] = [];
  const self: number[] = [];
  e.moves.forEach((m, i) => {
    if (m.category === 'attack') attack.push(i);
    else if (m.category === 'status') status.push(i);
    else if (m.category === 'shield' ? es.shieldTurns === 0 : m.category === 'buff' ? es.buffTurns === 0 : es.hp * 100 <= 60 * e.stats.hp) self.push(i);
  });
  const w = e.ai === 'tricky' ? [45, 40, 15] : e.ai === 'tank' ? [55, 15, 30] : [70, 20, 10];
  const wa = attack.length > 0 ? (w[0] as number) : 0;
  const ws = status.length > 0 && hero.status === null ? (w[1] as number) : 0;
  const wf = self.length > 0 ? (w[2] as number) : 0;
  const r1 = ctx.draw();
  const r2 = ctx.draw();
  const total = wa + ws + wf;
  if (total === 0) return 0;
  const pick = r1 % total;
  if (pick < wa) {
    if (r2 % 100 < 60) {
      let best = attack[0] as number;
      let bestScore = -1;
      for (const i of attack) {
        const m = e.moves[i] as MoveDef;
        const score = m.power * m.hits * (m.type === 'neutral' ? 1000 : typeEffect(m.type, heroSetup.type));
        if (score > bestScore) { best = i; bestScore = score; }
      }
      return best;
    }
    return attack[Math.floor(r2 / 100) % attack.length] as number;
  }
  const list = pick < wa + ws ? status : self;
  return list[r2 % list.length] as number;
}

// ------------------------------------------------------------------ turn

type Actor = 'hero' | 'enemy';

function doSwap(ctx: Ctx, to: number, forced: boolean): void {
  const from = ctx.s.active;
  if (!forced) ctx.clearTimed(PARTY(from));
  ctx.s.active = to;
  ctx.emit({ k: 'swap', from, to, forced });
}

function heroAct(ctx: Ctx, a: PlayerAction): void {
  const side = PARTY(ctx.s.active);
  const me = ctx.st(side);
  if (me.fainted) return;
  if (me.status === 'stunned') {
    ctx.emit({ k: 'skip', by: side, reason: 'stunned' });
    ctx.clearStatus(side);
    return;
  }
  if (me.status === 'merge-conflict' && ctx.draw() % 100 < CONFUSE_PCT) {
    ctx.emit({ k: 'confused', by: side });
    const c = ctx.cs(side);
    const d = computeDamage({ attacker: c, atkState: me, defender: c, defState: me, move: { type: 'neutral', power: SELF_HIT_POWER }, crit: false, spread: 100 });
    ctx.damage(side, d.amount, 'normal', false, true);
    return;
  }
  if (a.t === 'move') {
    useMove(ctx, side, a.move, ctx.cs(side).moves[a.move] as MoveDef);
  } else if (a.t === 'item') {
    const it = ctx.setup.items[a.item]!.def;
    const target = a.target ?? ctx.s.active;
    ctx.s.items[a.item] = (ctx.s.items[a.item] as number) - 1;
    ctx.emit({ k: 'item', item: a.item, target });
    if (it.effect === 'heal') ctx.heal(PARTY(target), Math.floor((ctx.cs(PARTY(target)).stats.hp * it.pct) / 100));
    else if (it.effect === 'heal-party') {
      ctx.s.party.forEach((p, i) => {
        if (!p.fainted) ctx.heal(PARTY(i), Math.floor((ctx.cs(PARTY(i)).stats.hp * it.pct) / 100));
      });
    } else if (it.effect === 'focus') {
      const t = ctx.st(PARTY(target));
      const gained = Math.max(0, Math.min(ctx.cs(PARTY(target)).stats.focus - t.focus, Math.floor((ctx.cs(PARTY(target)).stats.focus * it.pct) / 100)));
      t.focus += gained;
      ctx.emit({ k: 'focus', target: PARTY(target), amount: gained, focus: t.focus });
    } else ctx.clearStatus(PARTY(target));
  } else if (a.t === 'swap') {
    doSwap(ctx, a.to, false);
  } else if (a.t === 'run') {
    const spd = ctx.cs(side).stats.spd - ctx.setup.enemy.stats.spd;
    const chance = Math.min(95, Math.max(10, 40 + spd + 15 * ctx.s.runAttempts));
    const ok = ctx.draw() % 100 < chance;
    ctx.emit({ k: 'run', ok });
    if (ok) ctx.finish('fled');
    else ctx.s.runAttempts++;
  }
}

function enemyAct(ctx: Ctx, intent: number | null): void {
  if (ctx.s.enemy.fainted || ctx.s.party[ctx.s.active]?.fainted) return;
  if (ctx.s.enemy.status === 'stunned') {
    ctx.emit({ k: 'skip', by: ENEMY, reason: 'stunned' });
    ctx.clearStatus(ENEMY);
    return;
  }
  if (intent === null) return;
  if (ctx.s.enemy.status === 'merge-conflict' && ctx.draw() % 100 < CONFUSE_PCT) {
    ctx.emit({ k: 'confused', by: ENEMY });
    const c = ctx.setup.enemy;
    const d = computeDamage({ attacker: c, atkState: ctx.s.enemy, defender: c, defState: ctx.s.enemy, move: { type: 'neutral', power: SELF_HIT_POWER }, crit: false, spread: 100 });
    ctx.damage(ENEMY, d.amount, 'normal', false, true);
    return;
  }
  useMove(ctx, ENEMY, intent, ctx.setup.enemy.moves[intent] as MoveDef);
}

function endOfTurn(ctx: Ctx): void {
  const sides: Side[] = [PARTY(ctx.s.active), ENEMY];
  for (const side of sides) {
    const c = ctx.st(side);
    if (c.fainted || ctx.over) continue;
    if (c.status === 'burnout') ctx.damage(side, Math.max(1, Math.floor(ctx.cs(side).stats.hp / 12)), 'normal', false, false);
  }
  if (ctx.over) return;
  for (const side of sides) {
    const c = ctx.st(side);
    if (c.fainted) continue;
    if ((c.status === 'burnout' || c.status === 'merge-conflict') && --c.statusTurns <= 0) ctx.clearStatus(side);
    if (c.buffTurns > 0 && --c.buffTurns === 0) ctx.emit({ k: 'status', target: side, status: 'buffed', on: false });
    if (c.shieldTurns > 0 && --c.shieldTurns === 0) ctx.emit({ k: 'status', target: side, status: 'shielded', on: false });
  }
  const me = ctx.s.party[ctx.s.active] as CombatantState;
  if (!me.fainted) {
    const regen = Math.min(ctx.cs(PARTY(ctx.s.active)).stats.focus - me.focus, BASE_FOCUS_REGEN + ctx.cs(PARTY(ctx.s.active)).mods.focusRegen);
    if (regen > 0) {
      me.focus += regen;
      ctx.emit({ k: 'focus', target: PARTY(ctx.s.active), amount: regen, focus: me.focus });
    }
  }
}

function runTurn(ctx: Ctx, a: PlayerAction): void {
  ctx.emit({ k: 'turn', turn: ctx.s.turn });
  const intent = ctx.s.enemy.status === 'stunned' ? null : chooseEnemyMove(ctx);
  let order: Actor[] = ['hero', 'enemy'];
  if (a.t === 'move' && intent !== null) {
    const hm = ctx.cs(PARTY(ctx.s.active)).moves[a.move] as MoveDef;
    const em = ctx.setup.enemy.moves[intent] as MoveDef;
    const hs = ctx.cs(PARTY(ctx.s.active)).stats.spd;
    const es = ctx.setup.enemy.stats.spd;
    let heroFirst: boolean;
    if (hm.priority !== em.priority) heroFirst = hm.priority > em.priority;
    else if (hs !== es) heroFirst = hs > es;
    else heroFirst = ctx.draw() % 2 === 0;
    if (!heroFirst) order = ['enemy', 'hero'];
  }
  for (const who of order) {
    if (ctx.over) break;
    if (who === 'hero') heroAct(ctx, a);
    else enemyAct(ctx, intent);
  }
  if (!ctx.over) endOfTurn(ctx);
  ctx.s.turn++;
  if (ctx.over) return;
  if (ctx.s.turn > ctx.setup.maxTurns) ctx.finish('timeout');
  else if (ctx.s.party[ctx.s.active]?.fainted) ctx.s.phase = 'forced-swap';
}

export function applyAction(setup: BattleSetup, s: BattleState, a: PlayerAction): ApplyResult {
  if (s.phase === 'ended') return { ok: false, error: 'ended' };
  if (setup.engineVersion !== ENGINE_VERSION) return { ok: false, error: 'version' };
  if (s.phase === 'forced-swap') {
    if (a.t !== 'swap') return { ok: false, error: 'swap-required' };
    if (!alive(s.party[a.to]) || a.to === s.active) return { ok: false, error: 'bad-swap' };
    const ctx = new Ctx(setup, s);
    if (ctx.s.actions === 0) ctx.emit({ k: 'start' });
    doSwap(ctx, a.to, true);
    ctx.s.phase = 'choose';
    ctx.s.actions++;
    return { ok: true, state: ctx.s, events: ctx.events };
  }
  const me = s.party[s.active];
  if (!me) return { ok: false, error: 'bad-move' };
  if (a.t === 'move') {
    const mv = setup.party[s.active]?.moves[a.move];
    if (!mv || !Number.isInteger(a.move) || a.move < 0) return { ok: false, error: 'bad-move' };
    if (me.focus < mv.focusCost) return { ok: false, error: 'no-focus' };
  } else if (a.t === 'item') {
    if (!Number.isInteger(a.item) || a.item < 0 || a.item >= setup.items.length) return { ok: false, error: 'bad-item' };
    if ((s.items[a.item] ?? 0) <= 0) return { ok: false, error: 'no-item' };
    if (a.target !== undefined && !alive(s.party[a.target])) return { ok: false, error: 'bad-target' };
  } else if (a.t === 'swap') {
    if (!alive(s.party[a.to]) || a.to === s.active) return { ok: false, error: 'bad-swap' };
  }
  const ctx = new Ctx(setup, s);
  if (ctx.s.actions === 0) ctx.emit({ k: 'start' });
  runTurn(ctx, a);
  ctx.s.actions++;
  return { ok: true, state: ctx.s, events: ctx.events };
}

export function replay(setup: BattleSetup, log: readonly PlayerAction[]): ReplayResult {
  let state = createBattle(setup);
  const events: BattleEvent[] = [];
  for (let at = 0; at < log.length; at++) {
    const r = applyAction(setup, state, log[at] as PlayerAction);
    if (!r.ok) return { ok: false, error: r.error, at };
    state = r.state;
    events.push(...r.events);
  }
  return { ok: true, state, events, result: state.result, turns: state.turn - 1 };
}
