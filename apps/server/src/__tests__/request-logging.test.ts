import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { buildTestApp } from '../../test/helpers.js';

/** QA J: the supervisor's health polling must not flood the logs drawer; other requests still log. */
describe('request logging', () => {
  it('does not log /api/health requests but still logs other routes', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _enc, cb) {
        lines.push(chunk.toString('utf8'));
        cb();
      },
    });
    const app = await buildTestApp({ logger: { level: 'info', stream } });
    await app.inject({ url: '/api/health' });
    await app.inject({ url: '/api/health?x=1' });
    await app.inject({ url: '/api/nope' });
    await app.close();
    const text = lines.join('');
    expect(text).not.toContain('/api/health');
    expect(text).toContain('/api/nope');
  });
});
