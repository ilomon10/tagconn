import { skillPointsSpent, validateSkillAllocation, type HeroProgress, type SkillAllocation, type SkillCheck, type SkillNode, type SkillTree } from '@tagconn/shared';

/**
 * The pure model behind the skill tree view (docs/design/battles.md 3.8). A "plan" is the full desired allocation the
 * user is editing; nothing leaves the browser until Save. Every rule goes through `validateSkillAllocation`, so the
 * client preview cannot disagree with the server. Plans are null-prototype records and read with `Object.hasOwn`.
 */

export interface PlanCtx {
  tree: SkillTree;
  /** The allocation the server has stored (the baseline for the respec rule). */
  saved: SkillAllocation;
  level: number;
  /** `skillPointsTotal(level, perLevel, bonusPoints)`. */
  totalPoints: number;
  allowRespec: boolean;
}

export type PlanOp = { type: 'add' | 'remove'; id: string } | { type: 'clear' } | { type: 'reset'; to: SkillAllocation };

export type NodeState = 'maxed' | 'owned' | 'available' | 'locked';
export interface NodeStatus {
  state: NodeState;
  rank: number;
  /** Why the node cannot take another rank (null when it can). */
  addBlock: string | null;
  /** Why the node cannot lose a rank (null when it can; also null at rank 0 because there is nothing to remove). */
  removeBlock: string | null;
}

const nullProto = (): Record<string, number> => Object.create(null) as Record<string, number>;

export function rankIn(plan: SkillAllocation, id: string): number {
  if (!Object.hasOwn(plan, id)) return 0;
  const r = plan[id];
  return typeof r === 'number' && r > 0 ? r : 0;
}

function copy(plan: SkillAllocation): Record<string, number> {
  const out = nullProto();
  for (const k of Object.keys(plan)) out[k] = plan[k] as number;
  return out;
}

/** A fresh null-prototype copy of the stored allocation. */
export function planFrom(progress: Pick<HeroProgress, 'skills'>): Record<string, number> {
  return copy(progress.skills);
}

export const pointsSpent = (plan: SkillAllocation): number => skillPointsSpent(plan);
/** May be negative while the stored allocation is overspent. */
export const pointsLeft = (plan: SkillAllocation, totalPoints: number): number => totalPoints - skillPointsSpent(plan);

export function sameAllocation(a: SkillAllocation, b: SkillAllocation): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => rankIn(a, k) === rankIn(b, k));
}

const nodeOf = (tree: SkillTree, id: string): SkillNode | undefined => tree.nodes.find((n) => n.id === id);

/** Human text for a failed check (names the node a rule points at). */
export function describeCheck(check: SkillCheck, tree: SkillTree, labelOf: (n: SkillNode) => string = (n) => n.id): string {
  if (check.ok) return '';
  const node = check.skillId ? nodeOf(tree, check.skillId) : undefined;
  const name = node ? labelOf(node) : 'a skill';
  switch (check.code) {
    case 'unknown-skill':
      return 'Not a skill of this class';
    case 'rank-out-of-range':
      return `${name} is already at its highest rank`;
    case 'missing-prerequisite':
      return `Needs ${name} first`;
    case 'level-too-low':
      return `${name} unlocks at level ${node?.minLevel ?? '?'}`;
    case 'not-enough-points':
      return 'No skill points left';
    case 'respec-disabled':
      return 'Respec is turned off for this office';
  }
}

/** Can `plan` take one more rank of `id`? (Pure; the answer is `validateSkillAllocation` on the next plan.) */
export function canAdd(plan: SkillAllocation, id: string, ctx: PlanCtx): SkillCheck {
  const node = nodeOf(ctx.tree, id);
  if (!node) return { ok: false, code: 'unknown-skill', skillId: id };
  const next = copy(plan);
  next[id] = rankIn(plan, id) + 1;
  const check = validateSkillAllocation(ctx.tree, next, plan, ctx);
  return check;
}

/**
 * Can `plan` lose one rank of `id`? Refused when a dependent rank would be orphaned ('missing-prerequisite', pointing at
 * the prerequisite), or when it would go below the stored rank while respec is off and the stored plan is still valid.
 */
export function canRemove(plan: SkillAllocation, id: string, ctx: PlanCtx): SkillCheck {
  const node = nodeOf(ctx.tree, id);
  if (!node) return { ok: false, code: 'unknown-skill', skillId: id };
  const rank = rankIn(plan, id);
  if (rank < 1) return { ok: false, code: 'rank-out-of-range', skillId: id };
  const after = rank - 1;
  for (const dep of ctx.tree.nodes) {
    if (rankIn(plan, dep.id) < 1) continue;
    const need = dep.requires.find((r) => r.id === id);
    if (need && after < need.rank) return { ok: false, code: 'missing-prerequisite', skillId: id };
  }
  if (after < rankIn(ctx.saved, id) && !ctx.allowRespec && !savedIsBroken(ctx)) return { ok: false, code: 'respec-disabled', skillId: id };
  return { ok: true };
}

/** A stored plan that is overspent or invalid may always be reduced (it is the only way out). */
function savedIsBroken(ctx: PlanCtx): boolean {
  if (skillPointsSpent(ctx.saved) > ctx.totalPoints) return true;
  return !validateSkillAllocation(ctx.tree, ctx.saved, ctx.saved, {
    ...ctx,
    allowRespec: true,
  }).ok;
}

/** Whether the "Respec" button is offered: respec on, or the stored plan is broken. */
export const canRespec = (ctx: PlanCtx): boolean => ctx.allowRespec || savedIsBroken(ctx);

/** Applies `op`; a refused op returns the same plan object. */
export function apply(plan: SkillAllocation, op: PlanOp, ctx: PlanCtx): SkillAllocation {
  if (op.type === 'reset') return copy(op.to);
  if (op.type === 'clear') return canRespec(ctx) ? nullProto() : plan;
  if (op.type === 'add') {
    if (!canAdd(plan, op.id, ctx).ok) return plan;
    const next = copy(plan);
    next[op.id] = rankIn(plan, op.id) + 1;
    return next;
  }
  if (!canRemove(plan, op.id, ctx).ok) return plan;
  const next = copy(plan);
  const r = rankIn(plan, op.id) - 1;
  if (r < 1) delete next[op.id];
  else next[op.id] = r;
  return next;
}

/** The whole-plan check that gates Save. */
export const checkPlan = (plan: SkillAllocation, ctx: PlanCtx): SkillCheck => validateSkillAllocation(ctx.tree, plan, ctx.saved, ctx);

export function nodeStatus(plan: SkillAllocation, node: SkillNode, ctx: PlanCtx, labelOf: (n: SkillNode) => string): NodeStatus {
  const rank = rankIn(plan, node.id);
  const add = canAdd(plan, node.id, ctx);
  const rem = rank > 0 ? canRemove(plan, node.id, ctx) : ({ ok: true } as const);
  const unmet = node.requires.find((r) => rankIn(plan, r.id) < r.rank);
  let addBlock: string | null = null;
  if (!add.ok) {
    if (rank >= node.maxRank) addBlock = 'Max rank';
    else if (unmet) addBlock = `Needs ${nodeOf(ctx.tree, unmet.id) ? labelOf(nodeOf(ctx.tree, unmet.id) as SkillNode) : 'the skill before it'} first`;
    else if (ctx.level < node.minLevel) addBlock = `Unlocks at level ${node.minLevel}`;
    else addBlock = describeCheck(add, ctx.tree, labelOf);
  }
  const removeBlock = rem.ok ? null : rem.code === 'missing-prerequisite' ? 'A later skill depends on this one' : describeCheck(rem, ctx.tree, labelOf);
  // "locked" means a rule other than the point budget keeps an unowned node shut (level / prerequisite).
  const ruleLocked = rank < 1 && (!!unmet || ctx.level < node.minLevel);
  const state: NodeState = rank >= node.maxRank ? 'maxed' : ruleLocked ? 'locked' : rank > 0 ? 'owned' : 'available';
  return { state, rank, addBlock, removeBlock };
}

export type SaveFailure = { kind: 'conflict'; message: string } | { kind: 'other'; message: string };

/** Classifies a failed `saveSkills` by its message (the REST error text of a stale `baseUpdatedAt` is "... was changed since you loaded it"). */
export function classifySaveError(err: unknown): SaveFailure {
  const message = err instanceof Error ? err.message : String(err);
  return /changed since|baseUpdatedAt/i.test(message) ? { kind: 'conflict', message } : { kind: 'other', message };
}
