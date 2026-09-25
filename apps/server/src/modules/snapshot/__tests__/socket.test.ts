import type { Agent, ClientToServerEvents, OfficeSnapshot, ServerToClientEvents } from '@tagconn/shared';
import { OFFICE_NAMESPACE } from '@tagconn/shared';
import { io as connect, type Socket } from 'socket.io-client';
import { afterEach, describe, expect, it } from 'vitest';
import type { App } from '../../../app.js';
import { buildTestApp, loadFixture } from '../../../../test/helpers.js';

type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

describe('socket.io /office', () => {
  let app: App | undefined;
  let socket: ClientSocket | undefined;
  afterEach(async () => {
    socket?.disconnect();
    await app?.close();
    app = socket = undefined;
  });

  it('subscribes to all floors, receives a snapshot and live agent upserts', async () => {
    app = await buildTestApp();
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('no address');

    const client: ClientSocket = connect(`http://127.0.0.1:${address.port}${OFFICE_NAMESPACE}`, { transports: ['websocket'], forceNew: true });
    socket = client;
    await new Promise<void>((resolve, reject) => {
      client.on('connect', () => resolve());
      client.on('connect_error', reject);
    });

    const ack = await new Promise<Parameters<Parameters<ClientToServerEvents['office:subscribe']>[1]>[0]>((resolve) =>
      client.emit('office:subscribe', '*', resolve),
    );
    expect(ack.ok).toBe(true);
    expect((ack as { data: OfficeSnapshot }).data.agents).toEqual([]);

    const upsert = new Promise<Agent>((resolve) => client.on('agent:upsert', resolve));
    const [start] = loadFixture();
    const res = await app.inject({ method: 'POST', url: '/api/hooks', payload: start });
    expect(res.statusCode).toBe(202);
    const agent = await upsert;
    expect(agent).toMatchObject({ id: `main:${start?.session_id}`, isMain: true, role: 'pm', zone: 'pm-office' });

    const settings = await new Promise<{ ok: boolean }>((resolve) => client.emit('settings:get', resolve));
    expect(settings.ok).toBe(true);
    const roles = await new Promise<{ ok: boolean; data?: unknown[] }>((resolve) => client.emit('roles:list', resolve));
    expect(roles.data?.length).toBeGreaterThan(0);
  });
});
