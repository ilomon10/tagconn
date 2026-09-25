import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HookPayload, SettingsPatch } from '@tagconn/shared';
import { type BuildAppOptions, buildApp } from '../src/app.js';
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
