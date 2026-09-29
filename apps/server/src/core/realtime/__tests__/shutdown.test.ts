import { OFFICE_NAMESPACE } from '@tagconn/shared';
import { io as connect } from 'socket.io-client';
import { describe, expect, it } from 'vitest';
import { buildTestApp } from '../../../../test/helpers.js';

/** QA I: stopping the server must not wait for an open browser window (a connected socket.io client). */
describe('realtime shutdown', () => {
  it.each([['websocket'], ['polling']])('closes in well under a second with a %s client connected', async (transport) => {
    const app = await buildTestApp();
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('no address');
    const client = connect(`http://127.0.0.1:${address.port}${OFFICE_NAMESPACE}`, { transports: [transport as 'websocket' | 'polling'], forceNew: true, reconnection: false });
    await new Promise<void>((resolve, reject) => {
      client.on('connect', () => resolve());
      client.on('connect_error', reject);
    });
    const t0 = Date.now();
    // What main.ts does on SIGTERM.
    app.diContainer.cradle.io.engine.close();
    await app.close();
    expect(Date.now() - t0).toBeLessThan(1_000);
    client.close();
  });

  it('app.close() alone (preClose hook) also drops connected clients', async () => {
    const app = await buildTestApp();
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('no address');
    const client = connect(`http://127.0.0.1:${address.port}${OFFICE_NAMESPACE}`, { transports: ['websocket'], forceNew: true, reconnection: false });
    await new Promise<void>((resolve) => client.on('connect', () => resolve()));
    const t0 = Date.now();
    await app.close();
    expect(Date.now() - t0).toBeLessThan(1_000);
    client.close();
  });
});
