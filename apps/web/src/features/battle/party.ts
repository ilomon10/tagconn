// M14 F1: who can join a battle party (docs/design/battles.md 3.4). Pure.
import { classForRole, levelForXp, statsFor, xpFromUsage, type Agent, type Hero, type HeroProgress, type SkillAllocation, type Settings } from '@tagconn/shared';
import { clipDisplayText } from '../../lib/displayText';
import type { PartyCandidate } from './types';

const hasOwn = <T>(map: Readonly<Record<string, T>>, id: string): T | undefined => (Object.hasOwn(map, id) ? map[id] : undefined);

/** Bound live agent, status active and doing something. */
const isWorking = (a: Agent | undefined): boolean => !!a && a.status === 'active' && a.activity !== 'idle';

/** Who a candidate key stands for, so callers can paint it (the hero's look, or the anonymous agent's). */
export interface CandidateSource {
  hero?: Hero;
  agent?: Agent;
  role: string;
}

/** Resolves `PartyCandidate.key` (heroId or `agent:<agentId>`) back to its hero or agent. Null when it is gone. */
export function candidateSource(key: string, heroes: Readonly<Record<string, Hero>>, agents: Readonly<Record<string, Agent>>): CandidateSource | null {
  if (key.startsWith('agent:')) {
    const agent = hasOwn(agents, key.slice('agent:'.length));
    return agent ? { agent, role: agent.role } : null;
  }
  const hero = hasOwn(heroes, key);
  if (!hero) return null;
  const agent = hero.boundAgentId ? hasOwn(agents, hero.boundAgentId) : undefined;
  return { hero, agent, role: hero.role };
}

export function partyCandidates(
  heroes: Readonly<Record<string, Hero>>,
  agents: Readonly<Record<string, Agent>>,
  progress: Readonly<Record<string, HeroProgress>>,
  settings: Pick<Settings, 'progression'>,
  projectId: string,
  now: number,
): PartyCandidate[] {
  const p = settings.progression;
  const out: PartyCandidate[] = [];
  const boundAgents = new Set<string>();

  for (const hero of Object.values(heroes)) {
    if (hero.boundAgentId && hero.releasedAt === null) boundAgents.add(hero.boundAgentId);
    if (hero.projectId !== projectId) continue;
    const prog = hasOwn(progress, hero.id);
    const classId = prog?.classId ?? classForRole(hero.role);
    const level = prog?.level ?? 1;
    const bound = hero.releasedAt === null && hero.boundAgentId ? hasOwn(agents, hero.boundAgentId) : undefined;
    const koUntil = prog?.koUntil != null && prog.koUntil > now ? prog.koUntil : null;
    out.push({
      key: hero.id,
      ref: { kind: 'hero', heroId: hero.id },
      name: hero.name,
      classId,
      level,
      temporary: false,
      maxHp: statsFor(classId, level, (prog?.skills ?? {}) as SkillAllocation).hp,
      working: isWorking(bound),
      koUntil,
      selectable: koUntil === null,
    });
  }

  if (p.anonymousInBattle) {
    for (const agent of Object.values(agents)) {
      if (agent.projectId !== projectId || agent.status === 'done' || boundAgents.has(agent.id)) continue;
      const classId = classForRole(agent.role);
      const level = agent.usage ? levelForXp(xpFromUsage(agent.usage, p.xpWeights), p) : 1;
      out.push({
        key: `agent:${agent.id}`,
        ref: { kind: 'agent', agentId: agent.id },
        name: clipDisplayText(agent.description, 40) || agent.role,
        classId,
        level,
        temporary: true,
        maxHp: statsFor(classId, level, {} as SkillAllocation).hp,
        working: isWorking(agent),
        koUntil: null,
        selectable: true,
      });
    }
  }

  return out.sort((a, b) => Number(b.selectable) - Number(a.selectable) || b.level - a.level || a.name.localeCompare(b.name));
}

/** "4:12" for a KO timer (rounds up; never negative). */
export function formatKoTimer(koUntil: number, now: number): string {
  const s = Math.max(0, Math.ceil((koUntil - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
