import type { Activity, Agent, AgentStatus, BoundAgentState, Hero, HeroNamePools, OfficeLayout, OfficeLayoutInput, Project, Session, Task, TaskStatus, TokenUsage, Zone } from '@tagconn/shared';
import { DEFAULT_LAYOUT, HeroSchema, chooseHeroForAgent, generateHeroAppearance, heroRoleFor, heroSeed, namePoolFor, pickHeroName } from '@tagconn/shared';
import { generateRandomLayout } from '../game/procgen';
import { useHeroStore } from '../stores/heroStore';
import { useLayoutStore } from '../stores/layoutStore';
import { useOfficeStore } from '../stores/officeStore';
import { useSettingsStore } from '../stores/settingsStore';
import { sumUsage } from './tokens';

/**
 * Demo mode: a scripted software-house run fed through the same store actions the socket uses.
 * A PM spawns analyst → architect → 3 developers → qa / reviewer / security, then loops.
 *
 * Three floors showcase the guild skin and the stairs (docs/design/guild-hall.md section 8): the
 * ground floor is the built-in `DEFAULT_LAYOUT` (a walled "hall"), the middle floor is a
 * `generateRandomLayout` hall, and the top floor is a `void` keep with carved corridors.
 *
 * M8 8i heroes: every agent upsert runs through the same `chooseHeroForAgent` rule the server uses
 * (docs/design/living-office.md section 3.2), so the demo shows the same reuse/creation behaviour —
 * a fresh loop's "analyst-2" picks up the released hero left by loop 1's "analyst-1" instead of
 * spawning a new named character. Heroes persist in `localStorage` so a page reload doesn't reshuffle
 * every name and look.
 */

const PROJECT_ID = 'demo-tagconn';
const SIDE_PROJECT_ID = 'demo-pixel-garden';
const THIRD_PROJECT_ID = 'demo-sunken-keep';
const HALL_LAYOUT_ID = 'demo-random-hall';
const VOID_LAYOUT_ID = 'demo-sunken-keep';

/** Seeded once per demo start (not per loop) — layouts don't need to reshuffle every run. */
function seedDemoLayouts() {
  const now = Date.now();
  const toLayout = (input: OfficeLayoutInput, id: string): OfficeLayout => ({
    ...input,
    id,
    background: input.background ?? 'hall',
    corridorWidth: input.corridorWidth ?? 2,
    builtin: false,
    createdAt: now,
    updatedAt: now,
  });
  const hall = toLayout(generateRandomLayout({ width: 32, height: 24, seed: 4217, background: 'hall', name: 'Random Hall' }), HALL_LAYOUT_ID);
  const keep = toLayout(generateRandomLayout({ width: 48, height: 30, seed: 917, background: 'void', name: 'Sunken Keep' }), VOID_LAYOUT_ID);
  useLayoutStore.getState().setLayouts([DEFAULT_LAYOUT, hall, keep]);
}

// ------------------------------------------------------------------ M8 8i heroes (demo binding)

/** `localStorage` key heroes are persisted under; versioned so a future shape change starts fresh
 *  instead of failing `HeroSchema` forever. */
const DEMO_HEROES_KEY = 'tagconn:demo-heroes:v1';

function loadDemoHeroes(): Hero[] {
  try {
    const raw = window.localStorage.getItem(DEMO_HEROES_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const heroes: Hero[] = [];
    for (const item of parsed) {
      const result = HeroSchema.safeParse(item);
      if (result.success) heroes.push(result.data);
    }
    return heroes;
  } catch {
    // Private browsing, disabled storage, or corrupt JSON: start with no persisted heroes.
    return [];
  }
}

function saveDemoHeroes() {
  try {
    window.localStorage.setItem(DEMO_HEROES_KEY, JSON.stringify(Object.values(useHeroStore.getState().heroes)));
  } catch {
    // Best-effort only (quota, private mode): heroes just won't survive a reload.
  }
}

/** Server-generated id shape (`HERO_ID_RE`): `h-` + 8 lowercase hex chars, minted client-side here
 *  because demo mode has no server to hand one out. */
function nextHeroId(): string {
  const bytes = new Uint8Array(4);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  const id = `h-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
  return Object.hasOwn(useHeroStore.getState().heroes, id) ? nextHeroId() : id;
}

/** A readable fallback base for `pickHeroName` once a role's whole pool is taken: the role's plain
 *  (un-themed) title from the roles list, e.g. "Developer", falling back to the raw role key. */
function roleTitleFallback(role: string): string {
  return useSettingsStore.getState().roles.find((r) => r.name === role)?.title ?? role;
}

/** Every currently known agent, as the shape `chooseHeroForAgent` needs to judge liveness/idle-cutoff.
 *  An agent id absent from this map (removed from the floor) counts as gone, matching the server rule. */
function boundAgentStates(): ReadonlyMap<string, BoundAgentState> {
  const map = new Map<string, BoundAgentState>();
  for (const a of Object.values(office().agents)) map.set(a.id, { live: a.status !== 'done', activity: a.activity, lastEventAt: a.updatedAt });
  return map;
}

/** Runs the shared assignment rule for one agent upsert and applies the result to `heroStore`, mirroring
 *  `heroes.service.ts` on the server (docs/design/living-office.md section 3.2). Called after every
 *  `office().upsertAgent(...)` in this file. */
function bindHeroForAgent(agent: Agent) {
  const cfg = useSettingsStore.getState().settings.heroes;
  if (!cfg.enabled) return;
  const now = agent.updatedAt;
  const heroes = useHeroStore.getState();
  const bound = Object.values(heroes.heroes).find((h) => h.boundAgentId === agent.id);

  if (agent.status === 'done') {
    if (bound && bound.releasedAt === null) {
      heroes.upsertHero({ ...bound, releasedAt: now, updatedAt: now });
      saveDemoHeroes();
    }
    return;
  }

  if (bound) {
    if (bound.releasedAt !== null) {
      heroes.upsertHero({ ...bound, releasedAt: null, updatedAt: now });
      saveDemoHeroes();
    }
    return;
  }
  // A brand-new, still-idle agent (e.g. the side floors' napping PM) doesn't need a hero yet — the
  // real agent bus would not have fired an assignable event for it either.
  if (agent.activity === 'idle') return;

  const assignment = chooseHeroForAgent({
    agent: { id: agent.id, projectId: agent.projectId, isMain: agent.isMain, role: agent.role },
    heroes: Object.values(heroes.heroes),
    agents: boundAgentStates(),
    maxPerRole: cfg.maxPerRole,
    maxPerProject: cfg.maxPerProject,
    reuseIdleAfterSec: cfg.reuseIdleAfterSec,
    now,
  });

  if (assignment.kind === 'keep') {
    // `own` in `chooseHeroForAgent` already matches `bound` above, so this branch is unreachable here,
    // but handled for completeness/symmetry with the server.
    const h = heroes.heroes[assignment.heroId];
    if (h && h.releasedAt !== null) heroes.upsertHero({ ...h, releasedAt: null, updatedAt: now });
  } else if (assignment.kind === 'reuse') {
    const h = heroes.heroes[assignment.heroId];
    if (h) heroes.upsertHero({ ...h, boundAgentId: agent.id, boundAt: now, releasedAt: null, updatedAt: now });
  } else if (assignment.kind === 'create') {
    const role = heroRoleFor(agent);
    const seed = heroSeed(agent.projectId, role, assignment.slot);
    const taken = Object.values(heroes.heroes)
      .filter((h) => h.projectId === agent.projectId && h.role === role)
      .map((h) => h.name);
    const pools: HeroNamePools = useSettingsStore.getState().settings.heroes.namePools;
    const hero: Hero = {
      id: nextHeroId(),
      projectId: agent.projectId,
      role,
      slot: assignment.slot,
      name: pickHeroName(namePoolFor(pools, role), taken, seed, roleTitleFallback(role)),
      title: null,
      appearance: generateHeroAppearance(seed),
      customized: false,
      boundAgentId: agent.id,
      boundAt: now,
      releasedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    heroes.upsertHero(hero);
  }
  // 'none': caps reached — the agent stays anonymous, same as the real office.
  saveDemoHeroes();
}

/** Releases a hero bound to an agent that is about to be removed from the floor outright (matches the
 *  server's `agent.removed` handling); a no-op if it was already released at `finish()` time. */
function releaseHeroForAgent(agentId: string) {
  const heroes = useHeroStore.getState();
  const h = Object.values(heroes.heroes).find((x) => x.boundAgentId === agentId && x.releasedAt === null);
  if (h) {
    heroes.upsertHero({ ...h, releasedAt: Date.now(), updatedAt: Date.now() });
    saveDemoHeroes();
  }
}

/** Called before a fresh loop wipes the floor (`office().reset()`): every still-bound hero's agent is
 *  about to disappear at once, so release them all rather than leaving them bound forever. */
function releaseAllHeroes() {
  const heroes = useHeroStore.getState();
  const now = Date.now();
  let changed = false;
  for (const h of Object.values(heroes.heroes)) {
    if (h.boundAgentId !== null && h.releasedAt === null) {
      heroes.upsertHero({ ...h, releasedAt: now, updatedAt: now });
      changed = true;
    }
  }
  if (changed) saveDemoHeroes();
}

/** Not part of the public demo API — exported so tests can drive the binding rule and the
 *  `localStorage` persistence directly instead of running the full timer-based script. */
export const demoHeroes = { DEMO_HEROES_KEY, loadDemoHeroes, saveDemoHeroes, bindHeroForAgent, releaseHeroForAgent, releaseAllHeroes };

type Step = [seconds: number, run: () => void];

interface Ctx {
  run: number;
  sessionId: string;
  eventId: number;
}

const office = () => useOfficeStore.getState();

/** `age` staggers `createdAt` so `office.floorOrder: 'created'` (the default) puts them in a stable
 *  stairs order: the ground floor is whichever project has the smallest `age`. */
function project(id: string, name: string, cwd: string, age = 0, layoutId?: string): Project {
  const now = Date.now();
  return { id, name, cwd, archived: false, createdAt: now - 86_400_000 + age * 1000, lastActivityAt: now, ...(layoutId && { layoutId }) };
}

function makeHelpers(ctx: Ctx) {
  const now = () => Date.now();
  const get = (id: string) => office().agents[id];

  const event = (agentId: string, hookEvent: string, summary: string, toolName?: string, activity?: Activity, projectId = PROJECT_ID) => {
    const a = get(agentId);
    office().addEvent({
      id: ++ctx.eventId,
      ts: now(),
      projectId: a?.projectId ?? projectId,
      sessionId: a?.sessionId ?? ctx.sessionId,
      agentId,
      hookEvent,
      toolName,
      activity,
      summary,
    });
    const p = office().projects[a?.projectId ?? projectId];
    if (p) office().upsertProject({ ...p, lastActivityAt: now() });
  };

  const patch = (id: string, p: Partial<Agent>) => {
    const a = get(id);
    if (!a) return;
    const next = { ...a, ...p, updatedAt: now() };
    office().upsertAgent(next);
    bindHeroForAgent(next);
  };

  const task = (id: string, title: string, status: TaskStatus, extra: Partial<Task> = {}) => {
    const prev = office().tasks[id];
    const base: Task = prev ?? { id, projectId: PROJECT_ID, sessionId: ctx.sessionId, title, status, source: 'agent-call', createdAt: now(), updatedAt: now() };
    office().upsertTask({ ...base, ...extra, title, status, updatedAt: now() });
  };

  const setTask = (id: string, status: TaskStatus, extra: Partial<Task> = {}) => {
    const t = office().tasks[id];
    if (t) office().upsertTask({ ...t, ...extra, status, updatedAt: now() });
  };

  /** Adds one plausible "turn" of token usage to an agent, then re-sums it onto its session (main + subagents). */
  const bumpUsage = (agentId: string, opts: { big?: boolean } = {}) => {
    const a = get(agentId);
    if (!a) return;
    const prev = a.usage;
    const input = 20 + Math.floor(Math.random() * 80);
    const output = (opts.big ? 300 : 60) + Math.floor(Math.random() * (opts.big ? 900 : 240));
    const turn = input + output;
    const priorContext = prev?.contextTokens ?? 0;
    const usage: TokenUsage = {
      inputTokens: (prev?.inputTokens ?? 0) + input,
      outputTokens: (prev?.outputTokens ?? 0) + output,
      // A cache hit replays the prior context; this turn's new tokens get cached for next time.
      cacheReadTokens: (prev?.cacheReadTokens ?? 0) + priorContext,
      cacheCreationTokens: (prev?.cacheCreationTokens ?? 0) + turn,
      messages: (prev?.messages ?? 0) + 1,
      contextTokens: priorContext + turn,
      model: 'claude-sonnet-5',
    };
    patch(agentId, { usage });
    const session = office().sessions[a.sessionId];
    if (session) {
      const mates = Object.values(office().agents).filter((x) => x.sessionId === a.sessionId);
      office().upsertSession({ ...session, usage: sumUsage(mates) });
    }
  };

  const spawn = (id: string, role: string, agentType: string, description: string, zone: Zone, activity: Activity, bubble: string, projectId = PROJECT_ID, sessionId = ctx.sessionId, isMain = false) => {
    const agent: Agent = {
      id,
      sessionId,
      projectId,
      isMain,
      agentType,
      role,
      description,
      status: 'active',
      activity,
      zone,
      bubble,
      toolCount: 0,
      startedAt: now(),
      updatedAt: now(),
    };
    office().upsertAgent(agent);
    bindHeroForAgent(agent);
    event(id, isMain ? 'SessionStart' : 'SubagentStart', isMain ? 'Session started' : `${agentType} started: ${description}`, undefined, activity, projectId);
    bumpUsage(id, { big: true });
  };

  const tool = (id: string, toolName: string, activity: Activity, zone: Zone, bubble: string, status: AgentStatus = 'active') => {
    const a = get(id);
    if (!a) return;
    patch(id, { activity, zone, bubble, currentTool: toolName, toolCount: a.toolCount + 1, status, lastMessage: bubble });
    event(id, 'PreToolUse', bubble, toolName, activity);
    bumpUsage(id);
  };

  const finish = (id: string, taskId?: string, taskStatus: TaskStatus = 'done') => {
    patch(id, { status: 'done', activity: 'done', zone: 'entrance', bubble: 'Done!', currentTool: undefined, endedAt: now() });
    event(id, 'SubagentStop', 'Finished and handed off', undefined, 'done');
    if (taskId) setTask(taskId, taskStatus === 'done' ? 'review' : taskStatus);
    return taskId;
  };

  return { event, patch, task, setTask, spawn, tool, finish, get, now };
}

function script(ctx: Ctx, schedule: (at: number, fn: () => void) => void) {
  const h = makeHelpers(ctx);
  const r = ctx.run;
  const pm = `main:${ctx.sessionId}`;
  const id = (name: string) => `${name}-${r}`;
  const linger = () => Math.min(useSettingsStore.getState().settings.agents.doneLingerSec, 25);

  const remove = (agentId: string, at: number) =>
    schedule(at, () => {
      releaseHeroForAgent(agentId);
      office().removeAgent(agentId);
    });
  const finishAt = (at: number, agentId: string, taskId: string, status: TaskStatus = 'done') => {
    schedule(at, () => h.finish(agentId, taskId, status));
    if (status === 'done') schedule(at + 3, () => h.setTask(taskId, 'done'));
    remove(agentId, at + linger());
  };

  const steps: Step[] = [
    [0, () => {
      const session: Session = { id: ctx.sessionId, projectId: PROJECT_ID, status: 'active', startedAt: h.now(), lastPrompt: 'Add OAuth login with GitHub' };
      office().upsertSession(session);
      h.spawn(pm, 'pm', 'main', 'Main session', 'pm-office', 'thinking', 'Reading the brief', PROJECT_ID, ctx.sessionId, true);
      h.event(pm, 'UserPromptSubmit', 'Add OAuth login with GitHub');
    }],
    [3, () => {
      h.tool(pm, 'TodoWrite', 'thinking', 'whiteboard', 'Planning');
      for (const [k, title] of [
        ['req', 'Clarify OAuth requirements'], ['design', 'Design auth module'], ['cb', 'Implement OAuth callback'],
        ['store', 'Implement session store'], ['ui', 'Login button + UI states'], ['qa', 'E2E test login flow'],
        ['review', 'Review auth diff'], ['sec', 'Security audit of auth'],
      ] as const) h.task(id(`t-${k}`), title, 'todo', { source: 'todo' });
    }],
    [6, () => {
      h.tool(pm, 'Agent', 'delegating', 'meeting-room', 'Delegating: clarify requirements');
      h.spawn(id('analyst'), 'analyst', 'analyst', 'Clarify OAuth requirements', 'meeting-room', 'reading', 'Reading README.md');
      h.setTask(id('t-req'), 'doing', { assigneeAgentId: id('analyst'), role: 'analyst' });
    }],
    [9, () => h.tool(pm, 'Read', 'reading', 'pm-office', 'Reading CLAUDE.md')],
    [9, () => h.tool(id('analyst'), 'Grep', 'searching', 'library', 'Searching "session"')],
    [13, () => h.tool(id('analyst'), 'WebSearch', 'browsing', 'library', 'Researching OAuth PKCE')],
    [17, () => h.tool(id('analyst'), 'Read', 'reading', 'meeting-room', 'Reading docs/spec.md')],
    [21, () => h.tool(id('analyst'), 'Write', 'typing', 'meeting-room', 'Writing user stories')],
    [22, () => {
      h.tool(pm, 'Agent', 'delegating', 'meeting-room', 'Delegating: design auth module');
      h.spawn(id('architect'), 'architect', 'architect', 'Design auth module', 'whiteboard', 'thinking', 'Sketching modules');
      h.setTask(id('t-design'), 'doing', { assigneeAgentId: id('architect'), role: 'architect' });
    }],
    [26, () => h.tool(id('architect'), 'Read', 'reading', 'whiteboard', 'Reading src/server/app.ts')],
    [30, () => h.tool(id('architect'), 'Write', 'typing', 'whiteboard', 'Writing docs/adr-007-oauth.md')],
    [34, () => h.tool(pm, 'Read', 'reading', 'pm-office', 'Reading adr-007-oauth.md')],
  ];
  finishAt(24, id('analyst'), id('t-req'));
  finishAt(35, id('architect'), id('t-design'));

  // Wave of three developers.
  const devs = [
    { n: 'dev1', task: 't-cb', desc: 'Implement OAuth callback', files: ['src/auth/oauth.ts', 'src/auth/callback.ts', 'src/routes/auth.ts'] },
    { n: 'dev2', task: 't-store', desc: 'Implement session store', files: ['src/auth/session.ts', 'src/db/sessions.sql', 'src/auth/cookie.ts'] },
    { n: 'dev3', task: 't-ui', desc: 'Login button + UI states', files: ['web/LoginButton.tsx', 'web/useAuth.ts', 'web/Header.tsx'] },
  ];
  steps.push([37, () => h.tool(pm, 'Agent', 'delegating', 'meeting-room', 'Delegating: 3 developers in parallel')]);
  devs.forEach((d, i) => {
    const aid = id(d.n);
    const t0 = 38 + i;
    steps.push([t0, () => {
      h.spawn(aid, 'developer', 'developer', d.desc, 'desks', 'reading', `Reading ${d.files[0]}`);
      h.setTask(id(d.task), 'doing', { assigneeAgentId: aid, role: 'developer' });
    }]);
    d.files.forEach((f, j) => {
      steps.push([t0 + 3 + j * 5, () => h.tool(aid, 'Edit', 'typing', 'desks', `Editing ${f}`)]);
      steps.push([t0 + 5 + j * 5, () => h.tool(aid, 'Grep', 'searching', j === 1 ? 'library' : 'desks', `Searching ${f.split('/').pop()?.split('.')[0]}`)]);
    });
    steps.push([t0 + 19, () => h.tool(aid, 'Bash', 'testing', 'qa-lab', 'Running tests')]);
  });
  steps.push([46, () => h.tool(pm, 'Read', 'reading', 'pm-office', 'Watching progress')]);
  // dev3 gets blocked and the PM needs the human.
  steps.push([50, () => {
    h.tool(id('dev3'), 'Bash', 'blocked', 'desks', 'Blocked: OAUTH_CLIENT_ID missing', 'blocked');
    h.event(id('dev3'), 'Notification', 'Needs OAUTH_CLIENT_ID in .env');
  }]);
  steps.push([52, () => {
    h.tool(pm, 'AskUserQuestion', 'waiting', 'pm-office', 'Waiting for you: client id?', 'waiting');
    h.event(pm, 'Notification', 'Claude needs your input');
  }]);
  steps.push([58, () => {
    h.event(pm, 'UserPromptSubmit', 'Use the dev app id from 1Password');
    h.tool(pm, 'Agent', 'delegating', 'meeting-room', 'Unblocking dev3');
    h.tool(id('dev3'), 'Edit', 'typing', 'desks', 'Editing .env.example');
  }]);
  finishAt(60, id('dev1'), id('t-cb'));
  finishAt(62, id('dev2'), id('t-store'));
  finishAt(64, id('dev3'), id('t-ui'));

  // Verification wave.
  steps.push([66, () => {
    h.tool(pm, 'Agent', 'delegating', 'meeting-room', 'Delegating: QA, review, security');
    h.spawn(id('qa'), 'qa-engineer', 'qa-engineer', 'E2E test login flow', 'qa-lab', 'testing', 'Running playwright');
    h.spawn(id('rev'), 'code-reviewer', 'code-reviewer', 'Review auth diff', 'review-booth', 'reading', 'Reviewing diff');
    h.spawn(id('sec'), 'security-engineer', 'security-engineer', 'Security audit of auth', 'server-room', 'running', 'Security scan');
    h.setTask(id('t-qa'), 'doing', { assigneeAgentId: id('qa'), role: 'qa-engineer' });
    h.setTask(id('t-review'), 'doing', { assigneeAgentId: id('rev'), role: 'code-reviewer' });
    h.setTask(id('t-sec'), 'doing', { assigneeAgentId: id('sec'), role: 'security-engineer' });
  }]);
  steps.push(
    [70, () => h.tool(id('qa'), 'Write', 'typing', 'qa-lab', 'Writing e2e/login.spec.ts')],
    [70, () => h.tool(id('rev'), 'Read', 'reading', 'review-booth', 'Reading src/auth/oauth.ts')],
    [71, () => h.tool(id('sec'), 'Grep', 'searching', 'library', 'Searching "console.log(token"')],
    [74, () => h.tool(id('qa'), 'Bash', 'testing', 'qa-lab', 'Running tests')],
    [75, () => h.tool(id('sec'), 'Read', 'reading', 'server-room', 'Reading src/auth/callback.ts')],
    [76, () => h.tool(id('rev'), 'Bash', 'reading', 'review-booth', 'git diff main')],
    [79, () => h.tool(id('sec'), 'Bash', 'blocked', 'server-room', 'Token logged in plaintext!', 'blocked')],
    [80, () => {
      h.tool(pm, 'Agent', 'delegating', 'meeting-room', 'Delegating: fix token logging');
      h.task(id('t-fix'), 'Fix: token logged in plaintext', 'doing', { source: 'handoff', role: 'developer', assigneeAgentId: id('dev4') });
      h.spawn(id('dev4'), 'developer', 'developer', 'Fix: token logged in plaintext', 'desks', 'typing', 'Editing src/auth/callback.ts');
    }],
    [84, () => h.tool(id('dev4'), 'Bash', 'testing', 'qa-lab', 'Running tests')],
    [88, () => h.tool(id('sec'), 'Bash', 'running', 'server-room', 'pnpm audit')],
  );
  finishAt(82, id('qa'), id('t-qa'));
  finishAt(84, id('rev'), id('t-review'));
  finishAt(87, id('dev4'), id('t-fix'));
  finishAt(91, id('sec'), id('t-sec'), 'failed');
  steps.push(
    [93, () => h.tool(pm, 'Write', 'typing', 'pm-office', 'Writing summary')],
    [98, () => {
      h.patch(pm, { status: 'waiting', activity: 'waiting', bubble: 'Ready for your review', zone: 'pm-office' });
      h.event(pm, 'Stop', 'Turn finished: OAuth login ready for review', undefined, 'waiting');
    }],
  );

  for (const [at, fn] of steps) schedule(at, fn);
}

/** A second, quieter floor so the project selector has something to switch to. */
function sideProject(ctx: Ctx, schedule: (at: number, fn: () => void) => void) {
  const h = makeHelpers(ctx);
  const sid = `garden-${ctx.run}`;
  const pm = `main:${sid}`;
  const dev = `garden-dev-${ctx.run}`;
  schedule(1, () => {
    office().upsertSession({ id: sid, projectId: SIDE_PROJECT_ID, status: 'active', startedAt: h.now() });
    h.spawn(pm, 'pm', 'main', 'Main session', 'lounge', 'idle', 'Coffee break', SIDE_PROJECT_ID, sid, true);
    h.spawn(dev, 'developer', 'general-purpose', 'Tidy up sprite loader', 'desks', 'typing', 'Editing sprites.ts', SIDE_PROJECT_ID, sid);
  });
  const cycle: [string, Activity, Zone, string][] = [
    ['Read', 'reading', 'desks', 'Reading loader.ts'],
    ['Edit', 'typing', 'desks', 'Editing loader.ts'],
    ['Glob', 'searching', 'library', 'Searching **/*.png'],
    ['Bash', 'running', 'desks', '$ pnpm lint'],
    ['Edit', 'typing', 'desks', 'Editing atlas.ts'],
  ];
  for (let i = 0; i < 20; i++) {
    const c = cycle[i % cycle.length]!;
    schedule(6 + i * 5, () => h.tool(dev, c[0], c[1], c[2], c[3]));
  }
}

/** A third, quiet floor in the void-background "Sunken Keep" layout — mostly here to show the
 *  guild skin's corridor art and the stairs, not to run a full software-house script. */
function thirdFloor(ctx: Ctx, schedule: (at: number, fn: () => void) => void) {
  const h = makeHelpers(ctx);
  const sid = `keep-${ctx.run}`;
  const pm = `main:${sid}`;
  schedule(2, () => {
    office().upsertSession({ id: sid, projectId: THIRD_PROJECT_ID, status: 'active', startedAt: h.now() });
    h.spawn(pm, 'pm', 'main', 'Main session', 'entrance', 'idle', 'Exploring the sunken keep', THIRD_PROJECT_ID, sid, true);
  });
  const cycle: [Activity, Zone, string][] = [
    ['thinking', 'whiteboard', 'Mapping the vault'],
    ['reading', 'library', 'Reading old scrolls'],
    ['idle', 'lounge', 'Resting'],
  ];
  for (let i = 0; i < 15; i++) {
    const [activity, zone, bubble] = cycle[i % cycle.length]!;
    schedule(6 + i * 7, () => h.patch(pm, { activity, zone, bubble }));
  }
}

const RUN_SECONDS = 125;

export function startDemo(): () => void {
  seedDemoLayouts();
  useHeroStore.getState().setHeroes(loadDemoHeroes());
  const timers: ReturnType<typeof setTimeout>[] = [];
  const ctx: Ctx = { run: 0, sessionId: '', eventId: 0 };
  let stopped = false;

  const schedule = (at: number, fn: () => void) => {
    timers.push(
      setTimeout(() => {
        if (!stopped) fn();
      }, at * 1000),
    );
  };

  const run = () => {
    if (stopped) return;
    ctx.run += 1;
    ctx.sessionId = `demo-session-${ctx.run}`;
    // Fresh floor and board for every loop (layouts and heroes stay put — they're seeded/persisted
    // once, above/below). Every agent about to vanish releases its hero first, same as a real
    // `agent.removed` sweep, so the next loop's agents can reuse them instead of piling up new ones.
    if (ctx.run > 1) {
      releaseAllHeroes();
      office().reset();
    }
    office().upsertProject(project(PROJECT_ID, 'tagconn (demo)', '/home/you/code/tagconn', 0));
    office().upsertProject(project(SIDE_PROJECT_ID, 'pixel-garden (demo)', '/home/you/code/pixel-garden', 1, HALL_LAYOUT_ID));
    office().upsertProject(project(THIRD_PROJECT_ID, 'sunken-keep (demo)', '/home/you/code/sunken-keep', 2, VOID_LAYOUT_ID));
    script(ctx, schedule);
    sideProject(ctx, schedule);
    thirdFloor(ctx, schedule);
    schedule(RUN_SECONDS, () => {
      const s = office().sessions[ctx.sessionId];
      if (s) office().upsertSession({ ...s, status: 'ended', endedAt: Date.now() });
      run();
    });
  };
  run();

  return () => {
    stopped = true;
    for (const t of timers) clearTimeout(t);
  };
}
