import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HookPayload, SettingsPatch } from '@tagconn/shared';
import { type App, type BuildAppOptions, buildApp } from '../src/app.js';
import { deepMerge, type PlainObject } from '../src/core/config/index.js';

export const FIXTURE_PATH = join(import.meta.dirname, 'fixtures/subagent-session.json');

export const loadFixture = (): HookPayload[] => JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as HookPayload[];

/** Scratch dir under $TMPDIR (defaults to /tmp/claude-1000 in this repo's sandbox). */
export const makeTempDir = (prefix = 'tagconn-test-') => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), prefix));

/** In-memory app isolated from the host: no YAML, no env, agents dir in a temp folder. */
export function buildTestApp(opts: BuildAppOptions & { settings?: SettingsPatch } = {}) {
  const base: SettingsPatch = { paths: { agentsDir: join(makeTempDir(), 'agents') } };
  return buildApp({
    dbPath: ':memory:',
    configFile: false,
    env: {},
    logger: false,
    ...opts,
    settings: deepMerge(base as PlainObject, (opts.settings ?? {}) as PlainObject) as SettingsPatch,
  });
}

/**
 * Admin auth (M8 8m). Mints a session directly through `AuthService.createSession` (bypassing the
 * pairing code / same-origin bootstrap dance entirely: tests need a token, not to re-exercise that
 * flow), for use with `admin`/`admin-write` REST routes and gated socket events. `settings.auth.mode`
 * and `settings.auth.protect` default to `'pairing'`/`'all-writes'`, so most mutating requests in
 * existing tests now need this.
 */
export function mintAdminToken(app: App, label = 'test'): string {
  return app.diContainer.cradle.authService.createSession(label, 'vitest').token;
}

/** `Authorization: Bearer <token>` header for `app.inject({ headers: { ...adminHeaders(app) } })`. */
export function adminHeaders(app: App): { authorization: string } {
  return { authorization: `Bearer ${mintAdminToken(app)}` };
}

/** `auth` payload for `io(url, { auth: adminSocketAuth(app) })` (an admin-authenticated /office socket). */
export function adminSocketAuth(app: App): { adminToken: string } {
  return { adminToken: mintAdminToken(app) };
}
