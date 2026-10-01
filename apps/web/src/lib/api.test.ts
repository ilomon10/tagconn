import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from './api';
import { onAuthEvent } from './auth';

function memoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    get length() {
      return store.size;
    },
  } as Storage;
}

/** `request()` reads headers off the `RequestInit` it built, not a `Headers` instance, so the tests
 *  read `init.headers` directly (a plain object) the same way — see `apps/web/src/lib/api.ts`. */
function headersOf(init: RequestInit | undefined): Record<string, string> {
  return (init?.headers ?? {}) as Record<string, string>;
}

describe('api: Bearer header injection (M8 8m)', () => {
  let session: Storage;

  beforeEach(() => {
    session = memoryStorage();
    vi.stubGlobal('sessionStorage', session);
    vi.stubGlobal('localStorage', memoryStorage());
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })),
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  it('omits Authorization when no token is stored', async () => {
    await api.getSettings();
    const [, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(headersOf(init).authorization).toBeUndefined();
  });

  it('adds "Authorization: Bearer <token>" once a token is stored', async () => {
    session.setItem('tagconn.adminToken', 'tca_abc123');
    await api.getSettings();
    const [, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(headersOf(init).authorization).toBe('Bearer tca_abc123');
  });

  it('attaches the header on writes too, alongside content-type', async () => {
    session.setItem('tagconn.adminToken', 'tca_write');
    await api.patchSettings({});
    const [, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(headersOf(init).authorization).toBe('Bearer tca_write');
    expect(headersOf(init)['content-type']).toBe('application/json');
  });

  it('a 401 clears the stored token and emits a central auth event instead of failing silently', async () => {
    session.setItem('tagconn.adminToken', 'tca_dead');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })),
    );
    const seen: string[] = [];
    const off = onAuthEvent((e) => seen.push(e.message));
    await expect(api.getSettings()).rejects.toBeInstanceOf(ApiError);
    expect(session.getItem('tagconn.adminToken')).toBeNull();
    expect(seen).toEqual(['Pair this browser to make changes']);
    off();
  });

  it('a non-401 error leaves the stored token alone', async () => {
    session.setItem('tagconn.adminToken', 'tca_ok');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'boom' }), { status: 500 })),
    );
    await expect(api.getSettings()).rejects.toBeInstanceOf(ApiError);
    expect(session.getItem('tagconn.adminToken')).toBe('tca_ok');
  });
});

describe('api: M14 progression routes', () => {
  beforeEach(() => {
    vi.stubGlobal('sessionStorage', memoryStorage());
    vi.stubGlobal('localStorage', memoryStorage());
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  const lastCall = () => (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1) as [string, RequestInit];

  it('builds the progress, battle and hero-progress URLs and methods', async () => {
    await api.progress('p 1');
    expect(lastCall()[0]).toBe('/api/progress?projectId=p+1');
    await api.progress();
    expect(lastCall()[0]).toBe('/api/progress');
    await api.heroProgress('h-0123abcd');
    expect(lastCall()[0]).toBe('/api/heroes/h-0123abcd/progress');
    await api.healHero('h-0123abcd');
    expect(lastCall()[0]).toBe('/api/heroes/h-0123abcd/heal');
    expect(lastCall()[1].method).toBe('POST');
    await api.abandonBattle('b-0123456789ab');
    expect(lastCall()[0]).toBe('/api/battles/b-0123456789ab/abandon');
  });

  it('posts JSON bodies for skills, title, create and resolve', async () => {
    await api.saveSkills('h-0123abcd', { skills: { 'developer.0.1': 1 }, baseUpdatedAt: 5 });
    expect(lastCall()[0]).toBe('/api/heroes/h-0123abcd/skills');
    expect(JSON.parse(lastCall()[1].body as string)).toEqual({ skills: { 'developer.0.1': 1 }, baseUpdatedAt: 5 });
    await api.equipTitle('h-0123abcd', { title: null });
    expect(JSON.parse(lastCall()[1].body as string)).toEqual({ title: null });
    await api.createBattle({ projectId: 'p', npcKind: 'guest', encounterId: 'guest-1', party: [{ kind: 'agent', agentId: 'a' }] });
    expect(lastCall()[0]).toBe('/api/battles');
    await api.resolveBattle('b-0123456789ab', { log: [{ t: 'run' }] });
    expect(lastCall()[0]).toBe('/api/battles/b-0123456789ab/resolve');
    expect(headersOf(lastCall()[1])['content-type']).toBe('application/json');
  });
});
