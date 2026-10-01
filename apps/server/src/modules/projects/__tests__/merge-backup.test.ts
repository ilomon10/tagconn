import type { HookPayload } from '@tagconn/shared';
import { PROJECT_ROOT_HEADER, PROJECT_ROOT_KIND_HEADER } from '@tagconn/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTestApp } from '../../../../test/helpers.js';
import type { App } from '../../../app.js';

const backup = vi.hoisted(() => ({ fail: true, calls: 0 }));
vi.mock('../../../core/db/index.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../core/db/index.js')>();
  return {
    ...orig,
    backupBeforeMerge: (...args: Parameters<typeof orig.backupBeforeMerge>) => {
      backup.calls++;
      if (backup.fail) throw new Error('disk full');
      return orig.backupBeforeMerge(...args);
    },
  };
});

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

describe('merge backup failure cooldown', () => {
  let app: App | undefined;
  afterEach(async () => {
    vi.useRealTimers();
    await app?.close();
    app = undefined;
  });

  it('a failing backup skips merges for 60 s (one attempt, one warning), then retries', async () => {
    app = await buildTestApp();
    const { projectsService, projectsRepository, logger } = app.diContainer.cradle;
    const warn = vi.spyOn(logger, 'warn');
    const start = (sid: string, cwd: string, git = false) =>
      app!.inject({
        method: 'POST',
        url: '/api/hooks',
        headers: git ? { [PROJECT_ROOT_HEADER]: b64(cwd), [PROJECT_ROOT_KIND_HEADER]: 'git' } : {},
        payload: { session_id: sid, cwd, hook_event_name: 'SessionStart' } as HookPayload,
      });
    await start('c1', '/work/p/a/sub');
    await start('c2', '/work/p/b/sub');
    const t0 = Date.now();
    vi.useFakeTimers({ toFake: ['Date'], now: t0 });

    await start('g1', '/work/p/a', true);
    await projectsService.mergesSettled();
    await start('g2', '/work/p/b', true);
    await projectsService.mergesSettled();
    expect(backup.calls).toBe(1); // the second merge fell inside the cooldown
    expect(warn.mock.calls.filter((c) => String(c[1]).includes('could not back up'))).toHaveLength(1);
    expect(projectsRepository.listRecords().some((r) => r.cwd === '/work/p/a/sub')).toBe(true);

    vi.setSystemTime(t0 + 61_000);
    backup.fail = false;
    await start('g3', '/work/p/a', true);
    await projectsService.mergesSettled();
    expect(backup.calls).toBe(2);
    expect(projectsRepository.listRecords().some((r) => r.cwd === '/work/p/a/sub')).toBe(false);
  });
});
