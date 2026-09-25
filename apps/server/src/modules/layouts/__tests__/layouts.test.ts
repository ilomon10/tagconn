import type { ClientToServerEvents, LayoutIssue, OfficeLayout, OfficeSnapshot, Project, ServerToClientEvents } from '@tagconn/shared';
import { DEFAULT_LAYOUT, DEFAULT_LAYOUT_ID, OFFICE_NAMESPACE } from '@tagconn/shared';
import { io as connect, type Socket } from 'socket.io-client';
import { afterEach, describe, expect, it } from 'vitest';
import type { App } from '../../../app.js';
import { schema } from '../../../core/db/index.js';
import { adminHeaders, adminSocketAuth, buildTestApp, loadFixture } from '../../../../test/helpers.js';

type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/** DEFAULT_LAYOUT minus the server-owned fields: a geometry known to validate with 0 issues. */
const { id: _id, builtin: _builtin, createdAt: _createdAt, updatedAt: _updatedAt, ...validInput } = DEFAULT_LAYOUT;

describe('layouts module', () => {
  let app: App | undefined;
  let socket: ClientSocket | undefined;
  afterEach(async () => {
    socket?.disconnect();
    await app?.close();
    app = socket = undefined;
  });

  it('seeds the builtin default layout on boot, read-only and undeletable', async () => {
    app = await buildTestApp();
    const list = (await app.inject({ url: '/api/layouts' })).json<OfficeLayout[]>();
    const def = list.find((l) => l.id === DEFAULT_LAYOUT_ID);
    expect(def).toMatchObject({ id: DEFAULT_LAYOUT_ID, name: 'Classic Hall', builtin: true });

    const headers = adminHeaders(app);
    const putRes = await app.inject({ method: 'PUT', url: `/api/layouts/${DEFAULT_LAYOUT_ID}`, payload: validInput, headers });
    expect(putRes.statusCode).toBe(409);

    const delRes = await app.inject({ method: 'DELETE', url: `/api/layouts/${DEFAULT_LAYOUT_ID}`, headers });
    expect(delRes.statusCode).toBe(409);
  });

  it('lists builtins first, then by name', async () => {
    app = await buildTestApp();
    await app.inject({ method: 'POST', url: '/api/layouts', payload: { ...validInput, name: 'Aardvark Hall' }, headers: adminHeaders(app) });
    const list = (await app.inject({ url: '/api/layouts' })).json<OfficeLayout[]>();
    expect(list[0]?.builtin).toBe(true);
  });

  it('creates over REST with a generated id, 404s an unknown id', async () => {
    app = await buildTestApp();
    const res = await app.inject({ method: 'POST', url: '/api/layouts', payload: { ...validInput, name: 'East Wing' }, headers: adminHeaders(app) });
    expect(res.statusCode).toBe(201);
    const created = res.json<OfficeLayout>();
    expect(created.id).toMatch(/^east-wing-[0-9a-f]{8}$/);
    expect(created.builtin).toBe(false);

    const got = await app.inject({ url: `/api/layouts/${created.id}` });
    expect(got.statusCode).toBe(200);
    expect(got.json()).toEqual(created);

    expect((await app.inject({ url: '/api/layouts/does-not-exist' })).statusCode).toBe(404);
  });

  it('rejects an invalid layout with 400 and LayoutIssue[] details', async () => {
    app = await buildTestApp();
    const res = await app.inject({ method: 'POST', url: '/api/layouts', payload: { ...validInput, rooms: [] }, headers: adminHeaders(app) });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: string; statusCode: number; details: LayoutIssue[] }>();
    expect(body.statusCode).toBe(400);
    expect(body.details.some((i) => i.code === 'entrance-count')).toBe(true);
    expect(body.details.some((i) => i.code === 'stairs-missing')).toBe(true);
  });

  it('replaces over PUT (create-or-replace), keeping createdAt, and rejects a mismatched body id', async () => {
    app = await buildTestApp();
    const headers = adminHeaders(app);
    const first = (
      await app.inject({ method: 'PUT', url: '/api/layouts/my-hall', payload: { ...validInput, name: 'My Hall' }, headers })
    ).json<OfficeLayout>();
    expect(first.id).toBe('my-hall');

    await new Promise((r) => setTimeout(r, 2));
    const second = (
      await app.inject({ method: 'PUT', url: '/api/layouts/my-hall', payload: { ...validInput, id: 'my-hall', name: 'My Hall 2' }, headers })
    ).json<OfficeLayout>();
    expect(second.name).toBe('My Hall 2');
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);

    const mismatch = await app.inject({ method: 'PUT', url: '/api/layouts/my-hall', payload: { ...validInput, id: 'other-id' }, headers });
    expect(mismatch.statusCode).toBe(400);
  });

  it('deletes a layout and clears it from the projects that used it', async () => {
    app = await buildTestApp();
    const headers = adminHeaders(app);
    const [start] = loadFixture();
    await app.inject({ method: 'POST', url: '/api/hooks', payload: start });
    const [project] = (await app.inject({ url: '/api/projects' })).json<Project[]>();
    expect(project).toBeDefined();

    const layout = (
      await app.inject({ method: 'POST', url: '/api/layouts', payload: { ...validInput, name: 'Temp Hall' }, headers })
    ).json<OfficeLayout>();
    const assign = await app.inject({ method: 'PATCH', url: `/api/projects/${project!.id}`, payload: { layoutId: layout.id }, headers });
    expect(assign.statusCode).toBe(200);
    expect(assign.json<Project>().layoutId).toBe(layout.id);

    const del = await app.inject({ method: 'DELETE', url: `/api/layouts/${layout.id}`, headers });
    expect(del.statusCode).toBe(204);
    expect((await app.inject({ url: `/api/layouts/${layout.id}` })).statusCode).toBe(404);

    const [after] = (await app.inject({ url: '/api/projects' })).json<Project[]>();
    expect(after!.layoutId).toBeUndefined();
  });

  it('PATCH /api/projects/:id rejects an unknown layoutId with 400, and clears with null', async () => {
    app = await buildTestApp();
    const headers = adminHeaders(app);
    const [start] = loadFixture();
    await app.inject({ method: 'POST', url: '/api/hooks', payload: start });
    const [project] = (await app.inject({ url: '/api/projects' })).json<Project[]>();

    const bad = await app.inject({ method: 'PATCH', url: `/api/projects/${project!.id}`, payload: { layoutId: 'nope-nope' }, headers });
    expect(bad.statusCode).toBe(400);

    const ok = await app.inject({ method: 'PATCH', url: `/api/projects/${project!.id}`, payload: { layoutId: DEFAULT_LAYOUT_ID }, headers });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<Project>().layoutId).toBe(DEFAULT_LAYOUT_ID);

    const cleared = await app.inject({ method: 'PATCH', url: `/api/projects/${project!.id}`, payload: { layoutId: null }, headers });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json<Project>().layoutId).toBeUndefined();
  });

  it('rejects a PUT under an invalid or reserved URL id (400), instead of storing an unlistable row', async () => {
    app = await buildTestApp();
    const headers = adminHeaders(app);
    const badChars = await app.inject({ method: 'PUT', url: '/api/layouts/BAD%20ID!', payload: { ...validInput, name: 'Bad' }, headers });
    expect(badChars.statusCode).toBe(400);

    // Passes the old, looser id shape but is a reserved JS property name.
    const reserved = await app.inject({ method: 'PUT', url: '/api/layouts/constructor', payload: { ...validInput, name: 'Bad' }, headers });
    expect(reserved.statusCode).toBe(400);

    // Never got stored, so the list stays clean.
    const list = (await app.inject({ url: '/api/layouts' })).json<OfficeLayout[]>();
    expect(list.some((l) => l.id === 'constructor')).toBe(false);
  });

  it('rejects a PUT under the reserved "multiverse" id (M8 8h: the web-generated Multiverse floor)', async () => {
    app = await buildTestApp();
    const res = await app.inject({ method: 'PUT', url: '/api/layouts/multiverse', payload: { ...validInput, name: 'Sneaky' }, headers: adminHeaders(app) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/reserved/i);
    const list = (await app.inject({ url: '/api/layouts' })).json<OfficeLayout[]>();
    expect(list.some((l) => l.id === 'multiverse')).toBe(false);
  });

  it('purges stored rows with an invalid id on boot (old bug cleanup), leaving valid rows alone', async () => {
    app = await buildTestApp();
    const { db, layoutsRepository } = app.diContainer.cradle;
    // Simulate a row written before the PUT route validated its URL param.
    db.insert(schema.layouts).values({ id: 'BAD ID!', name: 'Junk', data: { ...validInput }, builtin: false, createdAt: 1, updatedAt: 1 }).run();
    expect(db.select().from(schema.layouts).all().some((r) => r.id === 'BAD ID!')).toBe(true);

    layoutsRepository.purgeInvalidIds();

    expect(db.select().from(schema.layouts).all().some((r) => r.id === 'BAD ID!')).toBe(false);
    expect(db.select().from(schema.layouts).all().some((r) => r.id === DEFAULT_LAYOUT_ID)).toBe(true);
  });

  it('enforces office.maxStoredLayouts with a 409 on create', async () => {
    app = await buildTestApp({ settings: { office: { maxStoredLayouts: 1 } } });
    // The seeded builtin already counts against the cap.
    const res = await app.inject({ method: 'POST', url: '/api/layouts', payload: { ...validInput, name: 'One Too Many' }, headers: adminHeaders(app) });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/maxStoredLayouts/);
  });

  it('rejects settings.office.defaultLayoutId that is not an existing layout, and reserved names', async () => {
    app = await buildTestApp();
    const headers = adminHeaders(app);
    const unknown = await app.inject({ method: 'PATCH', url: '/api/settings', payload: { office: { defaultLayoutId: 'nope-nope' } }, headers });
    expect(unknown.statusCode).toBe(400);

    const reserved = await app.inject({ method: 'PATCH', url: '/api/settings', payload: { office: { defaultLayoutId: 'constructor' } }, headers });
    expect(reserved.statusCode).toBe(400);

    const ok = await app.inject({ method: 'PATCH', url: '/api/settings', payload: { office: { defaultLayoutId: DEFAULT_LAYOUT_ID } }, headers });
    expect(ok.statusCode).toBe(200);
  });

  it('PUT with baseUpdatedAt 409s on a lost update or a deleted layout, and is backward compatible without it', async () => {
    app = await buildTestApp();
    const headers = adminHeaders(app);
    const created = (
      await app.inject({ method: 'PUT', url: '/api/layouts/concurrent-hall', payload: { ...validInput, name: 'V1' }, headers })
    ).json<OfficeLayout>();

    // Stale baseUpdatedAt (someone else saved first, or the client is just out of date).
    const stale = await app.inject({
      method: 'PUT',
      url: '/api/layouts/concurrent-hall',
      payload: { ...validInput, name: 'V2', baseUpdatedAt: created.updatedAt - 1 },
      headers,
    });
    expect(stale.statusCode).toBe(409);

    // Matching baseUpdatedAt succeeds.
    const fresh = await app.inject({
      method: 'PUT',
      url: '/api/layouts/concurrent-hall',
      payload: { ...validInput, name: 'V2', baseUpdatedAt: created.updatedAt },
      headers,
    });
    expect(fresh.statusCode).toBe(200);

    // Deleted-then-resurrected: baseUpdatedAt against a gone layout 409s instead of recreating it.
    await app.inject({ method: 'DELETE', url: '/api/layouts/concurrent-hall', headers });
    const resurrect = await app.inject({
      method: 'PUT',
      url: '/api/layouts/concurrent-hall',
      payload: { ...validInput, name: 'V3', baseUpdatedAt: fresh.json<OfficeLayout>().updatedAt },
      headers,
    });
    expect(resurrect.statusCode).toBe(409);

    // Without baseUpdatedAt, the old create-or-replace (recreate) behavior still works.
    const recreated = await app.inject({ method: 'PUT', url: '/api/layouts/concurrent-hall', payload: { ...validInput, name: 'V4' }, headers });
    expect(recreated.statusCode).toBe(200);
  });

  it('socket layouts:get/delete validate the id and never leak internals in the ack error', async () => {
    app = await buildTestApp();
    socket = await connectSocket();

    // Deliberately malformed, as a hostile/buggy client could send at runtime (the typed client can't).
    const badGet = await new Promise<{ ok: boolean; error?: string }>((resolve) =>
      socket!.emit('layouts:get', { not: 'a string' } as unknown as string, resolve),
    );
    expect(badGet.ok).toBe(false);

    const badDelete = await new Promise<{ ok: boolean; error?: string }>((resolve) =>
      socket!.emit('layouts:delete', 12345 as unknown as string, resolve),
    );
    expect(badDelete.ok).toBe(false);

    const notFound = await new Promise<{ ok: boolean; error?: string }>((resolve) => socket!.emit('layouts:get', 'does-not-exist', resolve));
    expect(notFound.ok).toBe(false);
    expect(notFound.error).toMatch(/not found/i);
  });

  it('snapshot includes layouts', async () => {
    app = await buildTestApp();
    const snap = (await app.inject({ url: '/api/snapshot' })).json<OfficeSnapshot>();
    expect(snap.layouts?.some((l) => l.id === DEFAULT_LAYOUT_ID)).toBe(true);
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

  it('supports layouts:list, layouts:save, layouts:delete over the socket', async () => {
    app = await buildTestApp();
    socket = await connectSocket();

    const list = await new Promise<{ ok: boolean; data?: OfficeLayout[] }>((resolve) => socket!.emit('layouts:list', resolve));
    expect(list.ok).toBe(true);
    expect(list.data?.some((l) => l.id === DEFAULT_LAYOUT_ID)).toBe(true);

    const saved = await new Promise<{ ok: boolean; data?: OfficeLayout }>((resolve) =>
      socket!.emit('layouts:save', { ...validInput, name: 'Socket Hall' }, resolve),
    );
    expect(saved.ok).toBe(true);
    expect(saved.data?.builtin).toBe(false);

    const invalid = await new Promise<{ ok: boolean; error?: string }>((resolve) =>
      socket!.emit('layouts:save', { ...validInput, rooms: [] }, resolve),
    );
    expect(invalid.ok).toBe(false);
    expect(invalid.error).toMatch(/entrance/i);

    const deleted = await new Promise<{ ok: boolean; data?: true }>((resolve) => socket!.emit('layouts:delete', saved.data!.id, resolve));
    expect(deleted.ok).toBe(true);
  });

  it('supports layouts:assign over the socket, and reports an unknown layout', async () => {
    app = await buildTestApp();
    const [start] = loadFixture();
    await app.inject({ method: 'POST', url: '/api/hooks', payload: start });
    const [project] = (await app.inject({ url: '/api/projects' })).json<Project[]>();
    socket = await connectSocket();

    const bad = await new Promise<{ ok: boolean; error?: string }>((resolve) =>
      socket!.emit('layouts:assign', { projectId: project!.id, layoutId: 'nope-nope' }, resolve),
    );
    expect(bad.ok).toBe(false);

    const good = await new Promise<{ ok: boolean; data?: Project }>((resolve) =>
      socket!.emit('layouts:assign', { projectId: project!.id, layoutId: DEFAULT_LAYOUT_ID }, resolve),
    );
    expect(good.ok).toBe(true);
    expect(good.data?.layoutId).toBe(DEFAULT_LAYOUT_ID);
  });

  it('broadcasts layout:upsert and layout:remove to every client', async () => {
    app = await buildTestApp();
    socket = await connectSocket();
    await new Promise<{ ok: boolean }>((resolve) => socket!.emit('office:subscribe', '*', resolve));

    const headers = adminHeaders(app);
    const upsert = new Promise<OfficeLayout>((resolve) => socket!.on('layout:upsert', resolve));
    const created = (
      await app.inject({ method: 'POST', url: '/api/layouts', payload: { ...validInput, name: 'Broadcast Hall' }, headers })
    ).json<OfficeLayout>();
    expect((await upsert).id).toBe(created.id);

    const removed = new Promise<string>((resolve) => socket!.on('layout:remove', resolve));
    await app.inject({ method: 'DELETE', url: `/api/layouts/${created.id}`, headers });
    expect(await removed).toBe(created.id);
  });
});
