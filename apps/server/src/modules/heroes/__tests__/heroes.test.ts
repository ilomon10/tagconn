import { join } from 'node:path';
import type { ClientToServerEvents, Hero, HookPayload, OfficeSnapshot, Project, ServerToClientEvents } from '@tagconn/shared';
import { MAIN_ROLE, OFFICE_NAMESPACE } from '@tagconn/shared';
import { io as connect, type Socket } from 'socket.io-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { App } from '../../../app.js';
import { adminHeaders, adminSocketAuth, buildTestApp, makeTempDir } from '../../../../test/helpers.js';
import { mainAgentId } from '../../agents/index.js';

type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const SESSION = 'hero-session';
const CWD = '/tmp/hero-project';
const hook = (p: Partial<HookPayload> & { hook_event_name: string }): HookPayload => ({ session_id: SESSION, ...p }) as HookPayload;

async function projectId(app: App): Promise<string> {
  const [project] = (await app.inject({ url: '/api/projects' })).json<Project[]>();
  if (!project) throw new Error('no project');
  return project.id;
}

describe('heroes module (M8 8i)', () => {
  let app: App | undefined;
  let socket: ClientSocket | undefined;
  afterEach(async () => {
    socket?.disconnect();
    await app?.close();
    app = socket = undefined;
  });

  it('binds a subagent to a named hero on its first live event', async () => {
    app = await buildTestApp();
    await app.inject({ method: 'POST', url: '/api/hooks', payload: hook({ hook_event_name: 'SessionStart', cwd: CWD }) });
    await app.inject({
      method: 'POST',
      url: '/api/hooks',
      payload: hook({ hook_event_name: 'SubagentStart', agent_id: 'sub-1', agent_type: 'general-purpose' }),
    });

    const pid = await projectId(app);
    const heroes = (await app.inject({ url: `/api/heroes?projectId=${pid}` })).json<Hero[]>();
    const hero = heroes.find((h) => h.boundAgentId === 'sub-1');
    expect(hero).toBeDefined();
    expect(hero).toMatchObject({ role: 'developer', slot: 0, customized: false });
    expect(hero!.name.length).toBeGreaterThan(0);
  });

  it('the main agent binds pm slot 0 when free', async () => {
    app = await buildTestApp();
    await app.inject({ method: 'POST', url: '/api/hooks', payload: hook({ hook_event_name: 'SessionStart', cwd: CWD }) });
    // SessionStart alone leaves the main agent `idle` (no hero yet, by design: an idle agent with no
    // hero is never auto-assigned, so a just-taken-over idle agent doesn't fight back for a new one).
    // Its first real event (a user prompt) is what claims the GM hero.
    await app.inject({ method: 'POST', url: '/api/hooks', payload: hook({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' }) });

    const pid = await projectId(app);
    const heroes = (await app.inject({ url: `/api/heroes?projectId=${pid}` })).json<Hero[]>();
    const gm = heroes.find((h) => h.boundAgentId === mainAgentId(SESSION));
    expect(gm).toMatchObject({ role: MAIN_ROLE, slot: 0 });
  });

  it('a second subagent of the same role reuses the first hero once it finishes', async () => {
    app = await buildTestApp();
    await app.inject({ method: 'POST', url: '/api/hooks', payload: hook({ hook_event_name: 'SessionStart', cwd: CWD }) });
    await app.inject({
      method: 'POST',
      url: '/api/hooks',
      payload: hook({ hook_event_name: 'SubagentStart', agent_id: 'sub-1', agent_type: 'general-purpose' }),
    });
    const pid = await projectId(app);
    const first = (await app.inject({ url: `/api/heroes?projectId=${pid}` })).json<Hero[]>().find((h) => h.boundAgentId === 'sub-1')!;

    // Finishing releases the hero right away (the bus sees `agent.upserted` with status 'done'
    // before the doneLingerSec removal timer ever fires).
    await app.inject({
      method: 'POST',
      url: '/api/hooks',
      payload: hook({ hook_event_name: 'SubagentStop', agent_id: 'sub-1', agent_type: 'general-purpose' }),
    });
    let heroes = (await app.inject({ url: `/api/heroes?projectId=${pid}` })).json<Hero[]>();
    expect(heroes.find((h) => h.id === first.id)).toMatchObject({ releasedAt: expect.any(Number), boundAgentId: 'sub-1' });

    await app.inject({
      method: 'POST',
      url: '/api/hooks',
      payload: hook({ hook_event_name: 'SubagentStart', agent_id: 'sub-2', agent_type: 'general-purpose' }),
    });
    heroes = (await app.inject({ url: `/api/heroes?projectId=${pid}` })).json<Hero[]>();
    const developerHeroes = heroes.filter((h) => h.role === 'developer');
    expect(developerHeroes).toHaveLength(1); // reused, not a second hero
    expect(developerHeroes[0]).toMatchObject({ id: first.id, name: first.name, boundAgentId: 'sub-2', releasedAt: null });
  });

  it('8a stale removal releases the hero, and a resumed agent keeps it (`keep`)', async () => {
    app = await buildTestApp({ settings: { agents: { staleAfterSec: 100, doneLingerSec: 0 } } });
    await app.inject({ method: 'POST', url: '/api/hooks', payload: hook({ hook_event_name: 'SessionStart', cwd: CWD }) });
    await app.inject({
      method: 'POST',
      url: '/api/hooks',
      payload: hook({ hook_event_name: 'SubagentStart', agent_id: 'sub-1', agent_type: 'general-purpose' }),
    });
    const pid = await projectId(app);
    const before = (await app.inject({ url: `/api/heroes?projectId=${pid}` })).json<Hero[]>().find((h) => h.boundAgentId === 'sub-1')!;

    app.diContainer.cradle.agentsService.sweep(Date.now() + 200_000); // lost SubagentStop: marked stale + done
    let heroes = (await app.inject({ url: `/api/heroes?projectId=${pid}` })).json<Hero[]>();
    expect(heroes.find((h) => h.id === before.id)).toMatchObject({ releasedAt: expect.any(Number), boundAgentId: 'sub-1' });

    // A later event for the same agent id: the row's own `boundAgentId` was never taken by anyone
    // else, so `chooseHeroForAgent` reports `keep` and it un-releases instead of creating anew.
    await app.inject({
      method: 'POST',
      url: '/api/hooks',
      payload: hook({ hook_event_name: 'PostToolUse', agent_id: 'sub-1', tool_name: 'Bash', tool_use_id: 't1', tool_response: {} }),
    });
    heroes = (await app.inject({ url: `/api/heroes?projectId=${pid}` })).json<Hero[]>();
    expect(heroes.find((h) => h.id === before.id)).toMatchObject({ releasedAt: null, boundAgentId: 'sub-1' });
  });

  it('takes over a long-idle live subagent\'s hero only past heroes.reuseIdleAfterSec, and the loser gets a hero back on its next non-idle event', async () => {
    app = await buildTestApp({ settings: { heroes: { reuseIdleAfterSec: 0.05 } } });
    await app.inject({ method: 'POST', url: '/api/hooks', payload: hook({ hook_event_name: 'SessionStart', cwd: CWD }) });
    await app.inject({
      method: 'POST',
      url: '/api/hooks',
      payload: hook({ hook_event_name: 'SubagentStart', agent_id: 'sub-1', agent_type: 'general-purpose' }),
    });
    const pid = await projectId(app);
    const h1 = (await app.inject({ url: `/api/heroes?projectId=${pid}` })).json<Hero[]>().find((h) => h.boundAgentId === 'sub-1')!;

    // Force the idle transition without waiting out agents.idleAfterSec (default 90s) in real time,
    // but stay well under agents.staleAfterSec (default 900s) so sub-1 isn't ALSO marked stale+done.
    app.diContainer.cradle.agentsService.sweep(Date.now() + 100_000);
    let heroes = (await app.inject({ url: `/api/heroes?projectId=${pid}` })).json<Hero[]>();
    expect(heroes.find((h) => h.id === h1.id)).toMatchObject({ boundAgentId: 'sub-1', releasedAt: null }); // still bound while idle

    // Too soon: reuseIdleAfterSec hasn't elapsed in real time yet.
    await app.inject({
      method: 'POST',
      url: '/api/hooks',
      payload: hook({ hook_event_name: 'SubagentStart', agent_id: 'sub-2', agent_type: 'general-purpose' }),
    });
    heroes = (await app.inject({ url: `/api/heroes?projectId=${pid}` })).json<Hero[]>();
    // Not eligible for takeover yet, but still under the role/project caps: a fresh hero is created
    // for sub-2 instead (h1 stays with sub-1, untouched).
    const sub2Hero = heroes.find((h) => h.boundAgentId === 'sub-2');
    expect(sub2Hero).toBeDefined();
    expect(sub2Hero!.id).not.toBe(h1.id);
    expect(heroes.find((h) => h.id === h1.id)).toMatchObject({ boundAgentId: 'sub-1' });

    await new Promise((r) => setTimeout(r, 150)); // now past the (tiny) reuseIdleAfterSec
    await app.inject({
      method: 'POST',
      url: '/api/hooks',
      payload: hook({ hook_event_name: 'SubagentStart', agent_id: 'sub-3', agent_type: 'general-purpose' }),
    });
    heroes = (await app.inject({ url: `/api/heroes?projectId=${pid}` })).json<Hero[]>();
    expect(heroes.find((h) => h.id === h1.id)).toMatchObject({ boundAgentId: 'sub-3' });

    // sub-1 is still on the floor (live, idle, no hero) until it does something again.
    await app.inject({
      method: 'POST',
      url: '/api/hooks',
      payload: hook({ hook_event_name: 'PreToolUse', agent_id: 'sub-1', tool_name: 'Bash', tool_use_id: 't2', tool_input: { command: 'echo hi' } }),
    });
    heroes = (await app.inject({ url: `/api/heroes?projectId=${pid}` })).json<Hero[]>();
    expect(heroes.find((h) => h.boundAgentId === 'sub-1')).toBeDefined();
  });

  it('no DB write happens on upserts that change nothing (already-bound live agent)', async () => {
    app = await buildTestApp();
    await app.inject({ method: 'POST', url: '/api/hooks', payload: hook({ hook_event_name: 'SessionStart', cwd: CWD }) });
    await app.inject({
      method: 'POST',
      url: '/api/hooks',
      payload: hook({ hook_event_name: 'SubagentStart', agent_id: 'sub-1', agent_type: 'general-purpose' }),
    });

    const upsertSpy = vi.spyOn(app.diContainer.cradle.heroesRepository, 'upsert');
    upsertSpy.mockClear();
    await app.inject({
      method: 'POST',
      url: '/api/hooks',
      payload: hook({ hook_event_name: 'PreToolUse', agent_id: 'sub-1', tool_name: 'Read', tool_use_id: 't1', tool_input: { file_path: 'a.txt' } }),
    });
    await app.inject({
      method: 'POST',
      url: '/api/hooks',
      payload: hook({ hook_event_name: 'PostToolUse', agent_id: 'sub-1', tool_name: 'Read', tool_use_id: 't1', tool_response: {} }),
    });
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it('stays stable across a restart on the same DB file: the same agent id keeps its hero', async () => {
    const dbPath = join(makeTempDir(), 'office.db');
    const before = await buildTestApp({ dbPath });
    await before.inject({ method: 'POST', url: '/api/hooks', payload: hook({ hook_event_name: 'SessionStart', cwd: CWD }) });
    await before.inject({
      method: 'POST',
      url: '/api/hooks',
      payload: hook({ hook_event_name: 'SubagentStart', agent_id: 'sub-1', agent_type: 'general-purpose' }),
    });
    const beforePid = await projectId(before);
    const original = (await before.inject({ url: `/api/heroes?projectId=${beforePid}` })).json<Hero[]>().find((h) => h.boundAgentId === 'sub-1')!;
    const heroId = original.id;
    const heroName = original.name;
    await before.close();

    app = await buildTestApp({ dbPath });
    await app.ready();
    await app.inject({
      method: 'POST',
      url: '/api/hooks',
      payload: hook({ hook_event_name: 'PreToolUse', agent_id: 'sub-1', tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'echo hi' } }),
    });
    const pid = await projectId(app);
    const hero = (await app.inject({ url: `/api/heroes?projectId=${pid}` })).json<Hero[]>().find((h) => h.boundAgentId === 'sub-1')!;
    expect(hero).toMatchObject({ id: heroId, name: heroName });
  });

  it('snapshot includes heroes for the subscribed floor(s)', async () => {
    app = await buildTestApp();
    await app.inject({ method: 'POST', url: '/api/hooks', payload: hook({ hook_event_name: 'SessionStart', cwd: CWD }) });
    await app.inject({ method: 'POST', url: '/api/hooks', payload: hook({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' }) });
    const snap = (await app.inject({ url: '/api/snapshot' })).json<OfficeSnapshot>();
    expect(snap.heroes?.some((h) => h.boundAgentId === mainAgentId(SESSION))).toBe(true);

    const all = (await app.inject({ url: '/api/snapshot?projectId=*' })).json<OfficeSnapshot>();
    expect(all.heroes?.some((h) => h.boundAgentId === mainAgentId(SESSION))).toBe(true);
  });

  it('REST CRUD: create (201, 404 unknown project, 409 caps), patch (409 stale baseUpdatedAt, 404), reset, delete (409 bound, 204)', async () => {
    app = await buildTestApp({ settings: { heroes: { maxPerRole: 1 } } });
    const headers = adminHeaders(app);
    await app.inject({ method: 'POST', url: '/api/hooks', payload: hook({ hook_event_name: 'SessionStart', cwd: CWD }) });
    await app.inject({ method: 'POST', url: '/api/hooks', payload: hook({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' }) });
    const pid = await projectId(app);

    const unknownProject = await app.inject({ method: 'POST', url: '/api/heroes', payload: { projectId: 'nope', role: 'analyst' }, headers });
    expect(unknownProject.statusCode).toBe(404);

    const created = await app.inject({ method: 'POST', url: '/api/heroes', payload: { projectId: pid, role: 'analyst' }, headers });
    expect(created.statusCode).toBe(201);
    const hero = created.json<Hero>();
    expect(hero).toMatchObject({ projectId: pid, role: 'analyst', slot: 0, boundAgentId: null });

    const capped = await app.inject({ method: 'POST', url: '/api/heroes', payload: { projectId: pid, role: 'analyst' }, headers });
    expect(capped.statusCode).toBe(409);
    expect(capped.json().error).toMatch(/maxPerRole/);

    const patched = await app.inject({ method: 'PATCH', url: `/api/heroes/${hero.id}`, payload: { name: 'Custom Name' }, headers });
    expect(patched.statusCode).toBe(200);
    expect(patched.json<Hero>()).toMatchObject({ name: 'Custom Name', customized: true });

    const stale = await app.inject({
      method: 'PATCH',
      url: `/api/heroes/${hero.id}`,
      payload: { name: 'Too Late', baseUpdatedAt: hero.updatedAt },
      headers,
    });
    expect(stale.statusCode).toBe(409);

    expect((await app.inject({ method: 'PATCH', url: '/api/heroes/h-deadbeef', payload: { name: 'X' }, headers })).statusCode).toBe(404);

    const reset = await app.inject({
      method: 'POST',
      url: `/api/heroes/${hero.id}/reset`,
      headers: { 'content-type': 'application/json', ...headers },
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json<Hero>()).toMatchObject({ name: hero.name, customized: false });

    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/heroes/h-deadbeef/reset',
          headers: { 'content-type': 'application/json', ...headers },
        })
      ).statusCode,
    ).toBe(404);

    // The GM hero is bound to a live agent: delete is rejected.
    const heroes = (await app.inject({ url: `/api/heroes?projectId=${pid}` })).json<Hero[]>();
    const gm = heroes.find((h) => h.role === MAIN_ROLE)!;
    const boundDelete = await app.inject({ method: 'DELETE', url: `/api/heroes/${gm.id}`, headers });
    expect(boundDelete.statusCode).toBe(409);

    const goodDelete = await app.inject({ method: 'DELETE', url: `/api/heroes/${hero.id}`, headers });
    expect(goodDelete.statusCode).toBe(204);
    expect((await app.inject({ url: `/api/heroes?projectId=${pid}` })).json<Hero[]>().some((h) => h.id === hero.id)).toBe(false);

    expect((await app.inject({ method: 'DELETE', url: '/api/heroes/h-deadbeef', headers })).statusCode).toBe(404);
  });

  async function connectSocket(): Promise<ClientSocket> {
    await app!.listen({ host: '127.0.0.1', port: 0 });
    const address = app!.server.address();
    if (!address || typeof address === 'string') throw new Error('no address');
    const client: ClientSocket = connect(`http://127.0.0.1:${address.port}${OFFICE_NAMESPACE}`, {
      transports: ['websocket'],
      forceNew: true,
      auth: adminSocketAuth(app!),
    });
    await new Promise<void>((resolve, reject) => {
      client.on('connect', () => resolve());
      client.on('connect_error', reject);
    });
    return client;
  }

  it('supports heroes:list/create/update/reset/delete over the socket, and broadcasts hero:upsert/hero:remove', async () => {
    app = await buildTestApp();
    await app.inject({ method: 'POST', url: '/api/hooks', payload: hook({ hook_event_name: 'SessionStart', cwd: CWD }) });
    const pid = await projectId(app);
    socket = await connectSocket();
    await new Promise<{ ok: boolean }>((resolve) => socket!.emit('office:subscribe', pid, resolve));

    const upsertEvent = new Promise<Hero>((resolve) => socket!.on('hero:upsert', resolve));
    const created = await new Promise<{ ok: boolean; data?: Hero }>((resolve) =>
      socket!.emit('heroes:create', { projectId: pid, role: 'qa-engineer' }, resolve),
    );
    expect(created.ok).toBe(true);
    expect((await upsertEvent).id).toBe(created.data!.id);

    const list = await new Promise<{ ok: boolean; data?: Hero[] }>((resolve) => socket!.emit('heroes:list', { projectId: pid }, resolve));
    expect(list.data?.some((h) => h.id === created.data!.id)).toBe(true);

    const updated = await new Promise<{ ok: boolean; data?: Hero }>((resolve) =>
      socket!.emit('heroes:update', { id: created.data!.id, patch: { title: 'The Bughunter' } }, resolve),
    );
    expect(updated.data).toMatchObject({ title: 'The Bughunter', customized: true });

    const reset = await new Promise<{ ok: boolean; data?: Hero }>((resolve) => socket!.emit('heroes:reset', created.data!.id, resolve));
    expect(reset.data).toMatchObject({ title: null, customized: false });

    const badId = await new Promise<{ ok: boolean; error?: string }>((resolve) => socket!.emit('heroes:reset', 'not-an-id', resolve));
    expect(badId.ok).toBe(false);

    const removeEvent = new Promise<string>((resolve) => socket!.on('hero:remove', resolve));
    const deleted = await new Promise<{ ok: boolean; data?: true }>((resolve) => socket!.emit('heroes:delete', created.data!.id, resolve));
    expect(deleted.ok).toBe(true);
    expect(await removeEvent).toBe(created.data!.id);
  });

  it('SC5 INFO: heroes:list is public over the socket, matching GET /api/heroes (both read-only, admin-gate should agree)', async () => {
    app = await buildTestApp();
    await app.inject({ method: 'POST', url: '/api/hooks', payload: hook({ hook_event_name: 'SessionStart', cwd: CWD }) });
    const pid = await projectId(app);

    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('no address');
    const anon: ClientSocket = connect(`http://127.0.0.1:${address.port}${OFFICE_NAMESPACE}`, { transports: ['websocket'], forceNew: true });
    socket = anon;
    await new Promise<void>((resolve, reject) => {
      anon.on('connect', () => resolve());
      anon.on('connect_error', reject);
    });

    const list = await new Promise<{ ok: boolean; data?: Hero[] }>((resolve) => anon.emit('heroes:list', { projectId: pid }, resolve));
    expect(list.ok).toBe(true); // never denied/timed-out by the admin-guard's per-packet check
  });
});
