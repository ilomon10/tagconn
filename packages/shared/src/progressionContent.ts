// M14 content (data only; numbers in docs/design/battles.md section 4). Themed names live web-side (labels).
import {
  CLASS_IDS, CLASS_TYPE,
  type BattleNpcKind, type BattleType, type ClassId, type EnemyDef, type ItemDef, type ItemId, type MajorStatus, type MoveDef, type SkillId, type SkillNode, type SkillTree, type Stats,
} from './progression.js';

type MoveOver = Partial<Omit<MoveDef, 'id' | 'type' | 'status' | 'self'>> & { status?: [MajorStatus, number, number, number]; self?: [NonNullable<MoveDef['self']>['id'], number] };
/** Every field is filled so a stored setup has a stable shape. `status` is [id, chancePct, minTurns, maxTurns]. */
function mv(id: string, type: BattleType, o: MoveOver = {}): MoveDef {
  return {
    id, type, category: o.category ?? 'attack', target: o.target ?? 'enemy', power: o.power ?? 0, hits: o.hits ?? 1, accuracy: o.accuracy ?? 100,
    focusCost: o.focusCost ?? 0, priority: o.priority ?? 0, critBonusPct: o.critBonusPct ?? 0, healPct: o.healPct ?? 0, cure: o.cure ?? false,
    status: o.status ? { id: o.status[0], chancePct: o.status[1], turns: [o.status[2], o.status[3]] } : null,
    self: o.self ? { id: o.self[0], turns: o.self[1] } : null,
  };
}
const atk = (power: number, accuracy: number, focusCost: number, extra: MoveOver = {}): MoveOver => ({ power, accuracy, focusCost, ...extra });
const heal = (healPct: number, focusCost: number, extra: MoveOver = {}): MoveOver => ({ category: 'heal', target: 'self', healPct, focusCost, ...extra });
const shield = (turns: number, focusCost: number, extra: MoveOver = {}): MoveOver => ({ category: 'shield', target: 'self', self: ['shielded', turns], focusCost, ...extra });
const buff = (turns: number, focusCost: number, extra: MoveOver = {}): MoveOver => ({ category: 'buff', target: 'self', self: ['buffed', turns], focusCost, ...extra });
const inflict = (st: [MajorStatus, number, number, number], accuracy: number, focusCost: number): MoveOver => ({ category: 'status', status: st, accuracy, focusCost });

export const CLASS_BASE: Readonly<Record<ClassId, Stats>> = {
  developer: { hp: 60, atk: 75, def: 55, spd: 60, focus: 50 },
  qa: { hp: 65, atk: 60, def: 70, spd: 55, focus: 50 },
  architect: { hp: 60, atk: 65, def: 60, spd: 45, focus: 70 },
  security: { hp: 70, atk: 60, def: 80, spd: 45, focus: 45 },
  reviewer: { hp: 55, atk: 65, def: 55, spd: 75, focus: 50 },
  analyst: { hp: 55, atk: 55, def: 55, spd: 65, focus: 70 },
  lead: { hp: 75, atk: 55, def: 65, spd: 55, focus: 50 },
  adventurer: { hp: 60, atk: 60, def: 60, spd: 60, focus: 50 },
};

export const BASIC_MOVE: Readonly<Record<ClassId, string>> = {
  developer: 'commit', qa: 'assert', architect: 'sketch', security: 'audit', reviewer: 'comment', analyst: 'query', lead: 'delegate', adventurer: 'shove',
};

const HERO_MOVES: MoveDef[] = [];
const hero = (cls: ClassId, id: string, o: MoveOver = {}, neutral = false): string => {
  HERO_MOVES.push(mv(id, neutral || o.category === 'heal' || o.category === 'buff' || o.category === 'shield' ? 'neutral' : CLASS_TYPE[cls], o));
  return id;
};

/** Per class: offense 1/2, defense 1/2, tempo 1/2 (the move unlocked at tier 2 / tier 4 of each branch). */
export const CLASS_MOVES: Readonly<Record<ClassId, readonly [string, string, string, string, string, string]>> = (() => {
  for (const c of CLASS_IDS) hero(c, BASIC_MOVE[c], { power: 40 });
  const h = hero;
  return {
    developer: [
      h('developer', 'hotfix', atk(70, 95, 8)), h('developer', 'refactor-strike', atk(100, 90, 14)),
      h('developer', 'stack-trace', atk(50, 100, 8, { status: ['stunned', 25, 1, 1] })), h('developer', 'rubber-duck', heal(40, 10, { cure: true })),
      h('developer', 'quick-deploy', atk(50, 100, 6, { priority: 1 })), h('developer', 'ship-it', atk(130, 75, 16)),
    ],
    qa: [
      h('qa', 'flaky-repro', atk(60, 95, 8, { status: ['merge-conflict', 30, 2, 3] })), h('qa', 'regression-suite', atk(100, 90, 14)),
      h('qa', 'unit-test-shield', shield(3, 8)), h('qa', 'green-build', heal(50, 12)),
      h('qa', 'smoke-test', atk(50, 100, 6, { priority: 1 })), h('qa', 'fuzz-barrage', atk(30, 85, 14, { hits: 3 })),
    ],
    architect: [
      h('architect', 'blueprint-beam', atk(70, 95, 8)), h('architect', 'grand-design', atk(100, 90, 14)),
      h('architect', 'load-bearing-wall', shield(3, 8)), h('architect', 'decouple', heal(30, 10, { cure: true })),
      h('architect', 'whiteboard-trap', inflict(['stunned', 50, 1, 1], 90, 8)), h('architect', 'paradigm-shift', atk(80, 90, 14, { self: ['buffed', 2] })),
    ],
    security: [
      h('security', 'pen-test', atk(70, 95, 8)), h('security', 'zero-day', atk(100, 90, 14)),
      h('security', 'firewall', shield(3, 8)), h('security', 'incident-response', heal(40, 12, { cure: true })),
      h('security', 'threat-model', buff(3, 6)), h('security', 'lockdown', atk(40, 95, 12, { status: ['stunned', 50, 1, 1] })),
    ],
    reviewer: [
      h('reviewer', 'nitpick', atk(25, 95, 8, { hits: 3 })), h('reviewer', 'blocking-review', atk(100, 90, 14)),
      h('reviewer', 'lgtm', heal(40, 10)), h('reviewer', 'style-guide', shield(2, 8, { cure: true })),
      h('reviewer', 'drive-by-comment', atk(50, 100, 6, { priority: 1 })), h('reviewer', 'merge-conflict', atk(30, 100, 10, { status: ['merge-conflict', 70, 2, 3] })),
    ],
    analyst: [
      h('analyst', 'grep-scan', atk(70, 95, 8)), h('analyst', 'root-cause', atk(100, 90, 14)),
      h('analyst', 'risk-register', shield(3, 8)), h('analyst', 'data-driven', buff(3, 6)),
      h('analyst', 'spreadsheet-storm', atk(30, 100, 10, { status: ['burnout', 60, 3, 5] })), h('analyst', 'deep-dive', atk(80, 95, 14, { critBonusPct: 20 })),
    ],
    lead: [
      h('lead', 'escalate', atk(70, 95, 8)), h('lead', 'crunch-time', atk(120, 85, 14, { self: ['burnout', 2] })),
      h('lead', 'roadmap', shield(3, 8)), h('lead', 'team-lunch', { category: 'heal', target: 'party', healPct: 30, focusCost: 14 }),
      h('lead', 'standup', inflict(['stunned', 40, 1, 1], 100, 8)), h('lead', 'pep-talk', buff(3, 12, { healPct: 20 })),
    ],
    adventurer: [
      h('adventurer', 'power-swing', atk(70, 95, 8)), h('adventurer', 'heroic-charge', atk(100, 90, 14)),
      h('adventurer', 'brace', shield(3, 8)), h('adventurer', 'second-wind', heal(40, 10)),
      h('adventurer', 'trip', atk(40, 100, 8, { status: ['stunned', 30, 1, 1] })), h('adventurer', 'last-stand', atk(90, 90, 14, { self: ['buffed', 2] })),
    ],
  };
})();

// ------------------------------------------------------------------ enemies

const ENEMY_MOVES: MoveDef[] = [];
const em = (type: BattleType, id: string, o: MoveOver = {}): string => {
  ENEMY_MOVES.push(mv(id, o.category === 'heal' || o.category === 'buff' || o.category === 'shield' ? 'neutral' : type, o));
  return id;
};
const eAtk = (power: number, accuracy = 100, extra: MoveOver = {}): MoveOver => ({ power, accuracy, ...extra });
const eShield = (turns: number): MoveOver => shield(turns, 0);
const eBuff = (turns: number): MoveOver => buff(turns, 0);

export const ENEMIES: Readonly<Record<BattleNpcKind, EnemyDef>> = {
  monster: {
    kind: 'monster', type: 'bug', base: { hp: 75, atk: 90, def: 22, spd: 50, focus: 50 }, ai: 'aggressive',
    moves: [em('bug', 'segfault', eAtk(40)), em('bug', 'null-pointer', eAtk(60, 90)), em('bug', 'race-condition', inflict(['merge-conflict', 45, 2, 3], 100, 0)), em('bug', 'memory-leak', inflict(['burnout', 50, 3, 5], 100, 0))],
    loot: [{ id: 'title-bug-squasher', weight: 3 }, { id: 'hat-hardhat', weight: 2 }, { id: 'prop-mop', weight: 2 }],
  },
  police: {
    kind: 'police', type: 'bureaucrat', base: { hp: 85, atk: 82, def: 28, spd: 40, focus: 50 }, ai: 'tank',
    moves: [em('bureaucrat', 'citation', eAtk(40)), em('bureaucrat', 'paperwork-pile', eAtk(60, 90)), em('bureaucrat', 'red-tape', inflict(['stunned', 35, 1, 1], 100, 0)), em('bureaucrat', 'by-the-book', eShield(2))],
    loot: [{ id: 'hat-police-cap', weight: 3 }, { id: 'title-red-tape-cutter', weight: 2 }, { id: 'prop-clipboard', weight: 2 }],
  },
  'cia-agent': {
    kind: 'cia-agent', type: 'bureaucrat', base: { hp: 70, atk: 90, def: 24, spd: 65, focus: 50 }, ai: 'tricky',
    moves: [em('bureaucrat', 'redact', eAtk(40)), em('bureaucrat', 'classified', eAtk(65, 85)), em('bureaucrat', 'surveillance', eBuff(2)), em('bureaucrat', 'interrogate', inflict(['merge-conflict', 45, 2, 3], 100, 0))],
    loot: [{ id: 'hat-fedora', weight: 3 }, { id: 'title-redacted', weight: 2 }, { id: 'prop-clipboard', weight: 1 }],
  },
  'sales-dog': {
    kind: 'sales-dog', type: 'salesy', base: { hp: 70, atk: 98, def: 20, spd: 70, focus: 50 }, ai: 'aggressive',
    moves: [em('salesy', 'pitch', eAtk(40)), em('salesy', 'upsell', eAtk(60, 90)), em('salesy', 'cold-call', inflict(['stunned', 30, 1, 1], 100, 0)), em('salesy', 'synergy', heal(25, 0))],
    loot: [{ id: 'title-unsold', weight: 3 }, { id: 'hat-cap', weight: 2 }, { id: 'prop-parcel', weight: 2 }],
  },
  guest: {
    kind: 'guest', type: 'rival', base: { hp: 70, atk: 82, def: 24, spd: 60, focus: 50 }, ai: 'tricky',
    moves: [em('rival', 'small-talk', eAtk(40)), em('rival', 'hot-take', eAtk(60, 90)), em('rival', 'humblebrag', eBuff(2)), em('rival', 'name-drop', inflict(['merge-conflict', 40, 2, 3], 100, 0))],
    loot: [{ id: 'title-rival-tamer', weight: 3 }, { id: 'prop-watering-can', weight: 2 }, { id: 'hat-cap', weight: 1 }],
  },
  'office-cat': {
    kind: 'office-cat', type: 'feral', base: { hp: 60, atk: 98, def: 18, spd: 90, focus: 50 }, ai: 'aggressive',
    moves: [em('feral', 'scratch', eAtk(40)), em('feral', 'zoomies', eAtk(50, 100, { priority: 1 })), em('feral', 'keyboard-walk', inflict(['merge-conflict', 45, 2, 3], 100, 0)), em('feral', 'hairball', inflict(['burnout', 45, 3, 5], 100, 0))],
    loot: [{ id: 'title-cat-whisperer', weight: 3 }, { id: 'prop-parcel', weight: 1 }],
  },
};

/** Hero + enemy moves by id (null prototype: ids come from content, but stay safe against `__proto__` lookups). */
export const MOVES: Readonly<Record<string, MoveDef>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, MoveDef>, Object.fromEntries([...HERO_MOVES, ...ENEMY_MOVES].map((m) => [m.id, m]))),
);

export const ITEMS: Readonly<Record<ItemId, ItemDef>> = {
  coffee: { id: 'coffee', effect: 'heal', pct: 40 },
  'energy-drink': { id: 'energy-drink', effect: 'focus', pct: 50 },
  'rubber-duck': { id: 'rubber-duck', effect: 'cure', pct: 0 },
  pizza: { id: 'pizza', effect: 'heal-party', pct: 25 },
};

// ------------------------------------------------------------------ skill trees

/** Section 4.3. Branch 0 offense, 1 defense, 2 tempo; tier n needs tier n-1 (rank >= 1). Tier 2/4 unlock CLASS_MOVES[branch * 2 + 0/1]. */
export const SKILL_TEMPLATE = {
  tierMinLevel: [1, 3, 8, 15],
  tierMaxRank: [5, 1, 3, 1],
} as const;

function buildTree(classId: ClassId): SkillTree {
  const moves = CLASS_MOVES[classId];
  const nodes: SkillNode[] = [];
  for (const branch of [0, 1, 2] as const) {
    for (const tier of [1, 2, 3, 4] as const) {
      const t1: SkillNode['effect'][] = [
        { kind: 'stat', stat: 'atk', pctPerRank: 4 },
        { kind: 'stat', stat: classId === 'lead' ? 'hp' : 'def', pctPerRank: 4 },
        { kind: 'stat', stat: 'spd', pctPerRank: 4 },
      ];
      const t3: SkillNode['effect'][] = [
        classId === 'qa' ? { kind: 'healBoost', pctPerRank: 10 } : { kind: 'crit', pctPerRank: 2 },
        { kind: 'statusResist', pctPerRank: 8 },
        classId === 'analyst' ? { kind: 'typeBoost', pctPerRank: 5 } : { kind: 'focusRegen', perRank: 1 },
      ];
      const effect: SkillNode['effect'] =
        tier === 1 ? (t1[branch] as SkillNode['effect']) : tier === 3 ? (t3[branch] as SkillNode['effect']) : { kind: 'move', moveId: moves[branch * 2 + (tier === 2 ? 0 : 1)] as string };
      nodes.push({
        id: `${classId}.${branch}.${tier}` as SkillId, classId, branch, tier,
        maxRank: SKILL_TEMPLATE.tierMaxRank[tier - 1] as number, minLevel: SKILL_TEMPLATE.tierMinLevel[tier - 1] as number,
        requires: tier === 1 ? [] : [{ id: `${classId}.${branch}.${tier - 1}` as SkillId, rank: 1 }],
        effect,
      });
    }
  }
  return { classId, nodes };
}

export const SKILL_TREES: Readonly<Record<ClassId, SkillTree>> = Object.fromEntries(CLASS_IDS.map((c) => [c, buildTree(c)])) as Record<ClassId, SkillTree>;
