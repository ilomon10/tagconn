import type { OfficeLayout } from '@tagconn/shared';
import { DEFAULT_LAYOUT } from '@tagconn/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { App } from '../../../app.js';
import { adminHeaders, buildTestApp } from '../../../../test/helpers.js';

const { id: _id, builtin: _b, createdAt: _c, updatedAt: _u, ...validInput } = DEFAULT_LAYOUT;

describe('QA M12 W2: pinned furniture persistence', () => {
  let app: App | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  const withPins = (pins: unknown[]) => ({ ...validInput, name: 'Pinned', rooms: validInput.rooms.map((r, i) => (i === 0 ? { ...r, furniture: pins } : r)) });

  it('stores and returns pins over POST, GET and PUT', async () => {
    app = await buildTestApp();
    const headers = adminHeaders(app);
    const pins = [{ kind: 'work-desk', x: 1, y: 1, w: 2, h: 1, variant: 2 }];
    const res = await app.inject({ method: 'POST', url: '/api/layouts', payload: withPins(pins), headers });
    expect(res.statusCode).toBe(201);
    const created = res.json<OfficeLayout>();
    expect(created.rooms[0]?.furniture).toEqual(pins);
    const got = (await app.inject({ url: `/api/layouts/${created.id}` })).json<OfficeLayout>();
    expect(got.rooms[0]?.furniture).toEqual(pins);
    const pins2 = [...pins, { kind: 'bookcase', x: 4, y: 1, w: 2, h: 1 }];
    const put = await app.inject({ method: 'PUT', url: `/api/layouts/${created.id}`, payload: withPins(pins2), headers });
    expect(put.statusCode).toBe(200);
    expect(((await app.inject({ url: '/api/layouts' })).json<OfficeLayout[]>().find((l) => l.id === created.id))?.rooms[0]?.furniture).toEqual(pins2);
  });

  it('a stale (outside-the-room) pin is a warning, so the layout still saves', async () => {
    app = await buildTestApp();
    const res = await app.inject({ method: 'POST', url: '/api/layouts', payload: withPins([{ kind: 'work-desk', x: 900, y: 900, w: 2, h: 1 }]), headers: adminHeaders(app) });
    expect(res.statusCode).toBe(201);
  });

  it('rejects malformed pins (bad kind, w=0, 49 pins) with 400', async () => {
    app = await buildTestApp();
    const headers = adminHeaders(app);
    for (const pins of [
      [{ kind: 'Bad Kind', x: 0, y: 0, w: 1, h: 1 }],
      [{ kind: 'desk', x: 0, y: 0, w: 0, h: 1 }],
      Array.from({ length: 49 }, (_, i) => ({ kind: 'desk', x: i, y: 0, w: 1, h: 1 })),
    ]) {
      const res = await app.inject({ method: 'POST', url: '/api/layouts', payload: withPins(pins), headers });
      expect(res.statusCode).toBe(400);
    }
  });
});
