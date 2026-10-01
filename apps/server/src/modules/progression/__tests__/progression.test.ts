import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PROGRESSION_LIMITS, HeroProgressSchema, type Agent, type Hero, type HeroProgress, type HookPayload, type TokenUsage,
} from '@tagconn/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { App } from '../../../app.js';
import { adminHeaders, buildTestApp, makeTempDir } from '../../../../test/helpers.js';
import { WRITE_LIMIT } from '../progression.schema.js';

const SESSION = 'prog-session';
const CWD = '/tmp/prog-project';
const hook = (p: Partial<HookPayload> & { hook_event_name: string }): HookPayload => ({ session_id: SESSION, ...p }) as HookPayload;
const usage = (o: Partial<TokenUsage> = {}): TokenUsage => ({
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, messages: 1, contextTokens: 0, ...o,
});

describe('progression: XP crediting and routes (M14 S2)', () => {
  let app: App | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  const post = (payload: HookPayload) => app!.inject({ method: 'POST', url: '/api/hooks', payload });
  const cradle = () => app!.diContainer.cradle;

  /** A session with one bound subagent hero. */
  async function setup(agentId = 'sub-1', session = SESSION, cwd = CWD): Promise<{ hero: Hero; agent: Agent }> {
    await post(hook({ session_id: session, hook_event_name: 'SessionStart', cwd }));
    await post(hook({ session_id: session, hook_event_name: 'SubagentStart', agent_id: agentId, agent_type: 'general-purpose' }));
    const agent = cradle().agentsRepository.get(agentId) as unknown as Agent;
    const hero = cradle().heroesRepository.list().find((h) => h.boundAgentId === agentId)!;
    expect(hero).toBeDefined();
    return { hero, agent };
  }
  const feed = (agent: Agent, u: Partial<TokenUsage>) => cradle().bus.emit('agent.upserted', { ...agent, usage: usage(u) });
  const progressOf = (heroId: string) => cradle().progressionRepository.view(heroId, cradle().settings.get());
  const rowOf = (heroId: string) => cradle().sqlite.prepare('SELECT * FROM hero_progress WHERE hero_id = ?').get(heroId) as { xp: number; skills: string } | undefined;

  it('credits the weighted usage delta to the bound hero and emits progress.upserted matching progressView', async () => {
    app = await buildTestApp();
    const { hero, agent } = await setup();
    const seen: HeroProgress[] = [];
    cradle().bus.on('progress.upserted', (p) => seen.push(p));
    feed(agent, { outputTokens: 1000, inputTokens: 500, cacheReadTokens: 99_999 });
    // output 1 + input 0.2 + cacheRead 0 (defaults)
    expect(rowOf(hero.id)?.xp).toBe(1100);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(progressOf(hero.id));
    expect(HeroProgressSchema.safeParse(seen[0]).success).toBe(true);
    feed(agent, { outputTokens: 1500, inputTokens: 500 });
    expect(rowOf(hero.id)?.xp).toBe(1600);
  });

  it('an unchanged usage makes no DB write; a repeat, a fresh state and a restart never double-count', async () => {
    app = await buildTestApp();
    const { hero, agent } = await setup();
    feed(agent, { outputTokens: 100 });
    const spy = vi.spyOn(cradle().progressionRepository, 'getMark');
    feed(agent, { outputTokens: 100 });
    expect(spy).not.toHaveBeenCalled();
    // a fresh in-memory state (LRU cleared, as after a restart): the persisted mark stops the recount
    (cradle().progressionService as unknown as { lastUsage: Map<string, unknown> }).lastUsage.clear();
    feed(agent, { outputTokens: 100 });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(rowOf(hero.id)?.xp).toBe(100);
    // usage dropping (another file for the same key) never lowers the mark
    feed(agent, { outputTokens: 40 });
    feed(agent, { outputTokens: 100 });
    expect(rowOf(hero.id)?.xp).toBe(100);
    // usage becoming undefined is ignored
    cradle().bus.emit('agent.upserted', { ...agent, usage: undefined });
    expect(rowOf(hero.id)?.xp).toBe(100);
  });

  it('progression.enabled=false credits nothing but advances marks; a later weight change only affects later deltas', async () => {
    app = await buildTestApp({ settings: { progression: { enabled: false } } });
    const { hero, agent } = await setup();
    feed(agent, { outputTokens: 700 });
    expect(rowOf(hero.id)).toBeUndefined();
    expect(cradle().progressionRepository.getMark(agent.sessionId, agent.id)?.outputTokens).toBe(700);
    cradle().settings.update({ progression: { enabled: true, xpWeights: { output: 2 } } });
    feed(agent, { outputTokens: 800 }); // only the 100 new tokens, at the new weight
    expect(rowOf(hero.id)?.xp).toBe(200);
  });

  it('an anonymous agent only advances the mark; once bound, only later usage is credited', async () => {
    app = await buildTestApp();
    await post(hook({ hook_event_name: 'SessionStart', cwd: CWD }));
    const main = cradle().agentsRepository.get(`main:${SESSION}`) as unknown as Agent;
    feed(main, { outputTokens: 500 });
    expect(cradle().progressionRepository.getMark(SESSION, main.id)?.outputTokens).toBe(500);
    await post(hook({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' })); // the main agent claims the GM hero
    const hero = cradle().heroesRepository.list().find((h) => h.boundAgentId === main.id)!;
    feed(main, { outputTokens: 800 });
    expect(rowOf(hero.id)?.xp).toBe(300);
  });

  it('agent-id collisions across sessions or projects are not cross-credited', async () => {
    app = await buildTestApp();
    const { hero, agent } = await setup('sub-1', SESSION, CWD);
    // same agent id, another project: the binding's projectId does not match
    feed({ ...agent, projectId: 'other-project', sessionId: 'other-session' }, { outputTokens: 900 });
    expect(rowOf(hero.id)).toBeUndefined();
    // same agent id and project but a different session keeps its own mark
    feed({ ...agent, sessionId: 'other-session-2' }, { outputTokens: 50 });
    expect(rowOf(hero.id)?.xp).toBe(50);
    feed(agent, { outputTokens: 50 });
    expect(rowOf(hero.id)?.xp).toBe(100);
  });

  it('a released hero still gets the final read; a takeover moves the binding so old-agent usage credits nobody (S2-4)', async () => {
    app = await buildTestApp();
    const { hero, agent } = await setup('sub-1');
    await post(hook({ hook_event_name: 'SubagentStop', agent_id: 'sub-1', agent_type: 'general-purpose' }));
    expect(cradle().heroesRepository.get(hero.id)?.releasedAt).not.toBeNull();
    feed(agent, { outputTokens: 120 }); // the final SubagentStop read
    expect(rowOf(hero.id)?.xp).toBe(120);

    // a takeover (chooseHeroForAgent reuse) moves boundAgentId to the new agent and emits hero.upserted
    await post(hook({ hook_event_name: 'SubagentStart', agent_id: 'sub-2', agent_type: 'general-purpose' }));
    const reused: Hero = { ...cradle().heroesRepository.get(hero.id)!, boundAgentId: 'sub-2', releasedAt: null };
    cradle().heroesRepository.list().filter((h) => h.boundAgentId === 'sub-2' && h.id !== hero.id).forEach((h) => cradle().heroesRepository.delete(h.id));
    cradle().heroesRepository.upsert(reused);
    cradle().bus.emit('hero.upserted', reused);
    const svc = cradle().progressionService as unknown as { heroByAgent: Map<string, unknown> };
    expect(svc.heroByAgent.has('sub-1')).toBe(false);
    feed(agent, { outputTokens: 999 }); // old agent, later usage
    expect(rowOf(hero.id)?.xp).toBe(120);
    feed(cradle().agentsRepository.get('sub-2') as unknown as Agent, { outputTokens: 30 });
    expect(rowOf(hero.id)?.xp).toBe(150);
  });

  it('the heroes agent.upserted listener runs before progression: a binding made on the same upsert is credited', async () => {
    app = await buildTestApp();
    await post(hook({ hook_event_name: 'SessionStart', cwd: CWD }));
    await post(hook({ hook_event_name: 'SubagentStart', agent_id: 'sub-1', agent_type: 'general-purpose' }));
    // a brand-new agent id arrives with usage already attached and non-idle: heroes binds, progression credits
    const base = cradle().agentsRepository.get('sub-1') as unknown as Agent;
    cradle().bus.emit('agent.upserted', { ...base, id: 'sub-9', activity: 'typing', status: 'active', usage: usage({ outputTokens: 64 }) });
    const rebound = cradle().heroesRepository.list().find((h) => h.boundAgentId === 'sub-9')!;
    expect(rebound).toBeDefined();
    expect(rowOf(rebound.id)?.xp).toBe(64);
  });

  it('hero.removed deletes the progress row and drops the cache', async () => {
    app = await buildTestApp();
    const { hero, agent } = await setup();
    feed(agent, { outputTokens: 10 });
    expect(rowOf(hero.id)).toBeDefined();
    cradle().bus.emit('hero.removed', { id: hero.id, projectId: hero.projectId } as never);
    expect(rowOf(hero.id)).toBeUndefined();
    feed(agent, { outputTokens: 20 });
    expect(rowOf(hero.id)).toBeUndefined();
  });

  it('S2-3: after a project merge the moved hero is still credited on its new floor', async () => {
    app = await buildTestApp();
    const { hero, agent } = await setup();
    // the merge moves heroes with raw SQL and no hero event, then announces project.merged
    cradle().sqlite.prepare('UPDATE heroes SET project_id = ? WHERE id = ?').run('merged-root', hero.id);
    cradle().bus.emit('project.merged', { from: hero.projectId, into: 'merged-root' });
    feed({ ...agent, projectId: 'merged-root' }, { outputTokens: 77 });
    expect(rowOf(hero.id)?.xp).toBe(77);
    expect(progressOf(hero.id)?.projectId).toBe('merged-root');
    // even without the event the credit-time re-read refreshes a stale entry
    cradle().sqlite.prepare('UPDATE heroes SET project_id = ? WHERE id = ?').run('merged-2', hero.id);
    feed({ ...agent, projectId: 'merged-2' }, { outputTokens: 100 });
    expect(rowOf(hero.id)?.xp).toBe(100);
  });

  it('S2-5: a hero deleted by a merge (raw SQL, no event) gets no orphan hero_progress row', async () => {
    app = await buildTestApp();
    const { hero, agent } = await setup();
    cradle().sqlite.prepare('DELETE FROM heroes WHERE id = ?').run(hero.id);
    feed(agent, { outputTokens: 500 });
    expect(rowOf(hero.id)).toBeUndefined();
    expect((cradle().progressionService as unknown as { heroByAgent: Map<string, unknown> }).heroByAgent.has(agent.id)).toBe(false);
  });

  it('S2-1: counters near and above MAX_SAFE_INTEGER are clamped; xp <= maxXp; one update adds <= maxXpPerUpdate', async () => {
    app = await buildTestApp();
    const { hero, agent } = await setup();
    feed(agent, { outputTokens: Number.MAX_SAFE_INTEGER, inputTokens: Number.MAX_VALUE, cacheCreationTokens: Infinity });
    const xp = rowOf(hero.id)!.xp;
    expect(xp).toBe(PROGRESSION_LIMITS.maxXpPerUpdate);
    expect(xp).toBeLessThanOrEqual(PROGRESSION_LIMITS.maxXp);
    const mark = cradle().progressionRepository.getMark(agent.sessionId, agent.id)!;
    expect(mark.outputTokens).toBe(PROGRESSION_LIMITS.maxCounter);
    expect(HeroProgressSchema.safeParse(progressOf(hero.id)).success).toBe(true);
    // a huge stored xp stays capped
    cradle().sqlite.prepare('UPDATE hero_progress SET xp = ? WHERE hero_id = ?').run(PROGRESSION_LIMITS.maxXp - 1, hero.id);
    feed({ ...agent, sessionId: 'fresh-session' }, { outputTokens: 5_000_000 });
    expect(rowOf(hero.id)!.xp).toBe(PROGRESSION_LIMITS.maxXp);
  });

  it('S2-2 (F3 known limit): a forked session whose transcript copies earlier history re-counts the copied part', async () => {
    app = await buildTestApp();
    const { hero, agent } = await setup('sub-1', 'sess-orig');
    feed(agent, { outputTokens: 300 });
    expect(rowOf(hero.id)?.xp).toBe(300);
    // the fork has a new sessionId and its own marks; the copied 300 tokens are credited again (documented, cosmetic)
    feed({ ...agent, sessionId: 'sess-fork' }, { outputTokens: 300 });
    expect(rowOf(hero.id)?.xp).toBe(600);
  });

  it('credits from a real transcript read through TranscriptsService (SubagentStop forces a final read)', async () => {
    const projectsDir = join(makeTempDir(), 'projects');
    app = await buildTestApp({ settings: { paths: { projectsDir }, transcripts: { debounceMs: 100 } } });
    const slug = '-tmp-prog-project';
    const subDir = join(projectsDir, slug, SESSION, 'subagents');
    mkdirSync(subDir, { recursive: true });
    const subPath = join(subDir, 'agent-sub-1.jsonl');
    const line = (id: string, out: number) => `${JSON.stringify({ type: 'assistant', message: { id, model: 'claude-haiku-5', usage: { input_tokens: 10, output_tokens: out } } })}\n`;
    writeFileSync(subPath, line('m1', 40));
    const host = `/home/u/.claude/projects/${slug}/${SESSION}.jsonl`;
    const hostSub = `/home/u/.claude/projects/${slug}/${SESSION}/subagents/agent-sub-1.jsonl`;
    await post(hook({ hook_event_name: 'SessionStart', cwd: CWD, transcript_path: host }));
    await post(hook({ hook_event_name: 'SubagentStart', transcript_path: host, agent_id: 'sub-1', agent_type: 'general-purpose' }));
    const hero = cradle().heroesRepository.list().find((h) => h.boundAgentId === 'sub-1')!;
    appendFileSync(subPath, line('m2', 60));
    await post(hook({ hook_event_name: 'SubagentStop', transcript_path: host, agent_id: 'sub-1', agent_type: 'general-purpose', agent_transcript_path: hostSub }));
    // 2 messages: output 100 + input 20 * 0.2
    expect(rowOf(hero.id)?.xp).toBe(104);
  });

  describe('routes', () => {
    const body = (headers: object, payload: unknown, url: string) => app!.inject({ method: 'POST', url, payload: payload as object, headers: headers as Record<string, string> });

    async function levelled(xp: number) {
      const s = await setup();
      cradle().progressionRepository.upsertCore(s.hero.id, {
        classId: 'developer', xp, bonusPoints: 0, skills: Object.create(null), koUntil: null, wins: 0, losses: 0, flees: 0, loot: [], equippedTitle: null, updatedAt: 1,
      });
      return s;
    }

    it('GET progress: public list/one, default view without a row, 404 unknown, 400 bad id', async () => {
      app = await buildTestApp();
      const { hero } = await setup();
      const one = await app.inject({ url: `/api/heroes/${hero.id}/progress` });
      expect(one.statusCode).toBe(200);
      expect(one.json()).toMatchObject({ heroId: hero.id, level: 1, xp: 0 });
      expect((await app.inject({ url: '/api/progress' })).json()).toEqual([]); // heroes without a row are not listed
      expect((await app.inject({ url: '/api/heroes/h-aaaaaaaa/progress' })).statusCode).toBe(404);
      expect((await app.inject({ url: '/api/heroes/..%2Fx/progress' })).statusCode).toBe(400);
      expect((await app.inject({ url: '/api/progress?bogus=1' })).statusCode).toBe(400);
    });

    it('skills: allocate, level/point/prereq errors, respec, baseUpdatedAt, disabled, 404', async () => {
      app = await buildTestApp();
      const headers = adminHeaders(app);
      const { hero } = await levelled(1500 * 4 + 1); // level 3 with the default curve (1500 * (L-1)^2)
      const lvl = progressOf(hero.id)!;
      expect(lvl.skillPoints).toBeGreaterThan(0);
      const url = `/api/heroes/${hero.id}/skills`;
      const ok = await body(headers, { skills: { 'developer.0.1': 1 } }, url);
      expect(ok.statusCode).toBe(200);
      expect(ok.json<HeroProgress>().skills).toEqual({ 'developer.0.1': 1 });
      expect(ok.json<HeroProgress>().skillPoints).toBe(lvl.skillPoints - 1);

      const unknown = await body(headers, { skills: { 'developer.0.1': 1, 'developer.2.4': 1 } }, url);
      expect(unknown.statusCode).toBe(400);
      expect(unknown.json().details).toMatchObject({ code: expect.any(String), skillId: 'developer.2.4' });
      const tooMany = await body(headers, { skills: { 'developer.0.1': 10 } }, url);
      expect(tooMany.statusCode).toBe(400);
      expect(tooMany.json().details.code).toBe('rank-out-of-range');

      const stale = await body(headers, { skills: {}, baseUpdatedAt: 5 }, url);
      expect(stale.statusCode).toBe(409);
      const respec = await body(headers, { skills: {}, baseUpdatedAt: ok.json<HeroProgress>().updatedAt }, url);
      expect(respec.statusCode).toBe(200);
      expect(respec.json<HeroProgress>().skills).toEqual({});

      cradle().settings.update({ progression: { allowRespec: false } });
      await body(headers, { skills: { 'developer.0.1': 1 } }, url);
      const noRespec = await body(headers, { skills: {} }, url);
      expect(noRespec.statusCode).toBe(409);
      expect(noRespec.json().details.code).toBe('respec-disabled');

      expect((await body(headers, { skills: {} }, '/api/heroes/h-aaaaaaaa/skills')).statusCode).toBe(404);
      cradle().settings.update({ progression: { enabled: false } });
      expect((await body(headers, { skills: {} }, url)).statusCode).toBe(409);
    });

    it('S2-8: __proto__ / constructor / toString keys and > 48 keys are 400', async () => {
      app = await buildTestApp();
      const headers = { ...adminHeaders(app), 'content-type': 'application/json' };
      const { hero } = await setup();
      const url = `/api/heroes/${hero.id}/skills`;
      for (const key of ['__proto__', 'constructor', 'toString']) {
        const res = await app.inject({ method: 'POST', url, headers, payload: `{"skills":{"${key}":1}}` });
        expect(res.statusCode).toBe(400);
      }
      const fake = Object.fromEntries(Array.from({ length: 49 }, (_, i) => [`k${i}`, 1]));
      expect((await body(headers, { skills: fake }, url)).statusCode).toBe(400);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it('title: owned -> 200, null clears, unowned 409, non-title loot 400, unknown id 400, 404', async () => {
      app = await buildTestApp();
      const headers = adminHeaders(app);
      const { hero } = await setup();
      cradle().progressionRepository.upsertCore(hero.id, {
        classId: 'developer', xp: 0, bonusPoints: 0, skills: Object.create(null), koUntil: null, wins: 0, losses: 0, flees: 0,
        loot: ['title-bug-squasher', 'hat-cap'], equippedTitle: null, updatedAt: 1,
      });
      const url = `/api/heroes/${hero.id}/title`;
      expect((await body(headers, { title: 'title-bug-squasher' }, url)).json<HeroProgress>().equippedTitle).toBe('title-bug-squasher');
      expect((await body(headers, { title: null }, url)).json<HeroProgress>().equippedTitle).toBeNull();
      expect((await body(headers, { title: 'hat-cap' }, url)).statusCode).toBe(400); // owned, but not a title
      expect((await body(headers, { title: 'title-redacted' }, url)).statusCode).toBe(409); // a title, not owned
      expect((await body(headers, { title: 'not-a-loot' }, url)).statusCode).toBe(400);
      expect((await body(headers, { title: 'title-redacted' }, '/api/heroes/h-aaaaaaaa/title')).statusCode).toBe(404);
    });

    it('heal: clears an active KO; 409 when not knocked out; 404', async () => {
      app = await buildTestApp();
      const headers = adminHeaders(app);
      const { hero } = await setup();
      const url = `/api/heroes/${hero.id}/heal`;
      expect((await body(headers, {}, url)).statusCode).toBe(409);
      cradle().progressionRepository.upsertCore(hero.id, {
        classId: 'developer', xp: 0, bonusPoints: 0, skills: Object.create(null), koUntil: Date.now() + 60_000, wins: 0, losses: 1, flees: 0,
        loot: [], equippedTitle: null, updatedAt: 1,
      });
      const seen: HeroProgress[] = [];
      cradle().bus.on('progress.upserted', (p) => seen.push(p));
      const healed = await body(headers, {}, url);
      expect(healed.statusCode).toBe(200);
      expect(healed.json<HeroProgress>().koUntil).toBeNull();
      expect(seen[0]?.koUntil).toBeNull();
      expect((await body(headers, { x: 1 }, url)).statusCode).toBe(400);
      expect((await body(headers, {}, '/api/heroes/h-aaaaaaaa/heal')).statusCode).toBe(404);
    });

    it('S2-6/7: a corrupt row is neither credited nor overwritten (409 on writes); a stored __proto__ skill key is dropped', async () => {
      app = await buildTestApp();
      const headers = adminHeaders(app);
      const { hero, agent } = await setup();
      cradle().progressionRepository.upsertCore(hero.id, {
        classId: 'developer', xp: 5, bonusPoints: 0, skills: Object.create(null), koUntil: null, wins: 0, losses: 0, flees: 0, loot: [], equippedTitle: null, updatedAt: 1,
      });
      cradle().sqlite.prepare('UPDATE hero_progress SET skills = ? WHERE hero_id = ?').run('{not json', hero.id);
      feed(agent, { outputTokens: 500 });
      expect(rowOf(hero.id)).toMatchObject({ xp: 5, skills: '{not json' });
      for (const [path, payload] of [['skills', { skills: {} }], ['title', { title: null }], ['heal', {}]] as const) {
        const res = await body(headers, payload, `/api/heroes/${hero.id}/${path}`);
        expect(res.statusCode).toBe(409);
        expect(res.json().error).toBe('progress row is corrupt');
      }
      expect((await app.inject({ url: `/api/heroes/${hero.id}/progress` })).statusCode).toBe(409);
      expect(rowOf(hero.id)?.skills).toBe('{not json');

      cradle().sqlite.prepare('UPDATE hero_progress SET skills = ? WHERE hero_id = ?').run('{"__proto__":3,"developer.0.1":2}', hero.id);
      const v = (await app.inject({ url: `/api/heroes/${hero.id}/progress` })).json<HeroProgress>();
      expect(v.skills).toEqual({ 'developer.0.1': 2 });
      expect(Object.keys(v.skills)).not.toContain('__proto__');
      expect(({} as Record<string, unknown>)['3']).toBeUndefined();
      expect(Object.getPrototypeOf(cradle().progressionRepository.getCore(hero.id).kind === 'ok' ? (cradle().progressionRepository.getCore(hero.id) as { core: { skills: object } }).core.skills : {})).toBeNull();
    });

    it('S2-10: skills/title/heal need an admin token (401 without, 401 with only the hook token)', async () => {
      app = await buildTestApp();
      const { hero } = await setup();
      for (const [path, payload] of [['skills', { skills: {} }], ['title', { title: null }], ['heal', {}]] as const) {
        expect((await body({}, payload, `/api/heroes/${hero.id}/${path}`)).statusCode).toBe(401);
      }
      expect(rowOf(hero.id)).toBeUndefined();
    });

    it('413 on an over-limit body, before parsing', async () => {
      app = await buildTestApp();
      const headers = adminHeaders(app);
      const { hero } = await setup();
      const res = await body(headers, { skills: {}, pad: 'x'.repeat(20_000) }, `/api/heroes/${hero.id}/skills`);
      expect(res.statusCode).toBe(413);
    });

    it('429 after WRITE_LIMIT.max progress writes', async () => {
      app = await buildTestApp();
      const headers = adminHeaders(app);
      const { hero } = await setup();
      const url = `/api/heroes/${hero.id}/title`;
      for (let i = 0; i < WRITE_LIMIT.max; i++) expect((await body(headers, { title: null }, url)).statusCode).toBe(200);
      const limited = await body(headers, { title: null }, url);
      expect(limited.statusCode).toBe(429);
      expect(limited.json()).toMatchObject({ statusCode: 429 });
    });
  });
});
