import type { HookContext } from '../../../core/event-bus/index.js';
import type { App } from '../../../app.js';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp } from '../../../../test/helpers.js';

const SESSION = 'run-id-header-session';
const CWD = '/tmp/run-id-header-project';
const VALID_UUID = '11111111-2222-4333-8444-555555555555';

describe('POST /api/hooks x-tagconn-run-id header (M8 8k, S5)', () => {
  let app: App | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('passes a UUID-shaped header through as HookContext.runIdHint', async () => {
    app = await buildTestApp();
    const contexts: HookContext[] = [];
    app.diContainer.cradle.bus.on('hook.received', (ctx) => contexts.push(ctx));

    const res = await app.inject({
      method: 'POST',
      url: '/api/hooks',
      headers: { 'x-tagconn-run-id': VALID_UUID },
      payload: { session_id: SESSION, cwd: CWD, hook_event_name: 'SessionStart' },
    });

    expect(res.statusCode).toBe(202);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.runIdHint).toBe(VALID_UUID);
  });

  it('ignores a header that is not UUID-shaped', async () => {
    app = await buildTestApp();
    const contexts: HookContext[] = [];
    app.diContainer.cradle.bus.on('hook.received', (ctx) => contexts.push(ctx));

    const res = await app.inject({
      method: 'POST',
      url: '/api/hooks',
      headers: { 'x-tagconn-run-id': 'not-a-uuid' },
      payload: { session_id: SESSION, cwd: CWD, hook_event_name: 'SessionStart' },
    });

    expect(res.statusCode).toBe(202);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.runIdHint).toBeUndefined();
  });

  it('leaves runIdHint undefined when the header is absent', async () => {
    app = await buildTestApp();
    const contexts: HookContext[] = [];
    app.diContainer.cradle.bus.on('hook.received', (ctx) => contexts.push(ctx));

    const res = await app.inject({
      method: 'POST',
      url: '/api/hooks',
      payload: { session_id: SESSION, cwd: CWD, hook_event_name: 'SessionStart' },
    });

    expect(res.statusCode).toBe(202);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.runIdHint).toBeUndefined();
  });
});
