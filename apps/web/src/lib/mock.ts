import type { Activity, Agent, AgentStatus, Project, Session, Task, TaskStatus, TokenUsage, Zone } from '@tagconn/shared';
import { useOfficeStore } from '../stores/officeStore';
import { useSettingsStore } from '../stores/settingsStore';
import { sumUsage } from './tokens';

/**
 * Demo mode: a scripted software-house run fed through the same store actions the socket uses.
 * A PM spawns analyst → architect → 3 developers → qa / reviewer / security, then loops.
 */

const PROJECT_ID = 'demo-tagconn';
const SIDE_PROJECT_ID = 'demo-pixel-garden';

type Step = [seconds: number, run: () => void];

interface Ctx {
  run: number;
  sessionId: string;
  eventId: number;
}

const office = () => useOfficeStore.getState();

function project(id: string, name: string, cwd: string): Project {
  const now = Date.now();
  return { id, name, cwd, archived: false, createdAt: now - 86_400_000, lastActivityAt: now };
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
    if (a) office().upsertAgent({ ...a, ...p, updatedAt: now() });
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
    office().upsertAgent({
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
    });
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

  const remove = (agentId: string, at: number) => schedule(at, () => office().removeAgent(agentId));
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

const RUN_SECONDS = 125;

export function startDemo(): () => void {
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
    // Fresh floor and board for every loop.
    if (ctx.run > 1) office().reset();
    office().upsertProject(project(PROJECT_ID, 'tagconn (demo)', '/home/you/code/tagconn'));
    office().upsertProject(project(SIDE_PROJECT_ID, 'pixel-garden (demo)', '/home/you/code/pixel-garden'));
    script(ctx, schedule);
    sideProject(ctx, schedule);
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
