import { describe, expect, it } from 'vitest';
import { buildRunEnv } from '../../src/env.js';

const sourceEnv = {
  HOME: '/home/user',
  PATH: '/usr/bin:/bin',
  USER: 'user',
  LANG: 'en_US.UTF-8',
  LC_TIME: 'en_GB.UTF-8',
  XDG_CONFIG_HOME: '/home/user/.config',
  ANTHROPIC_API_KEY: 'sk-should-never-appear',
  ANTHROPIC_BASE_URL: 'https://evil.example.com',
  CLAUDE_CODE_USE_BEDROCK: '1',
  AWS_BEARER_TOKEN_BEDROCK: 'secret',
  SOME_RANDOM_VAR: 'not-allowlisted',
  MY_CUSTOM_VAR: 'should-be-passed-via-passEnv',
};

describe('buildRunEnv', () => {
  it('keeps the base allowlist (HOME, PATH, USER, LANG, ...)', () => {
    const env = buildRunEnv({ runId: 'r1', runKind: 'quest', passEnv: [], sourceEnv });
    expect(env.HOME).toBe('/home/user');
    expect(env.PATH).toBe('/usr/bin:/bin');
    expect(env.LANG).toBe('en_US.UTF-8');
  });

  it('always passes through LC_* and XDG_* regardless of passEnv', () => {
    const env = buildRunEnv({ runId: 'r1', runKind: 'quest', passEnv: [], sourceEnv });
    expect(env.LC_TIME).toBe('en_GB.UTF-8');
    expect(env.XDG_CONFIG_HOME).toBe('/home/user/.config');
  });

  it('strips ANTHROPIC_*, CLAUDE_CODE_USE_* and AWS_BEARER_TOKEN_BEDROCK, even if never allowlisted', () => {
    const env = buildRunEnv({ runId: 'r1', runKind: 'quest', passEnv: [], sourceEnv });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(env.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined();
  });

  it('strip prefixes win even if the name is explicitly in passEnv', () => {
    const env = buildRunEnv({ runId: 'r1', runKind: 'quest', passEnv: ['ANTHROPIC_API_KEY'], sourceEnv });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('drops an unlisted variable not covered by the base allowlist, LC_*/XDG_*, or passEnv', () => {
    const env = buildRunEnv({ runId: 'r1', runKind: 'quest', passEnv: [], sourceEnv });
    expect(env.SOME_RANDOM_VAR).toBeUndefined();
  });

  it('adds a passEnv name explicitly', () => {
    const env = buildRunEnv({ runId: 'r1', runKind: 'quest', passEnv: ['MY_CUSTOM_VAR'], sourceEnv });
    expect(env.MY_CUSTOM_VAR).toBe('should-be-passed-via-passEnv');
  });

  it('always sets TAGCONN_RUN_ID and TAGCONN_RUN_KIND', () => {
    const env = buildRunEnv({ runId: 'r-abc', runKind: 'receptionist', passEnv: [], sourceEnv });
    expect(env.TAGCONN_RUN_ID).toBe('r-abc');
    expect(env.TAGCONN_RUN_KIND).toBe('receptionist');
  });

  it('sets TAGCONN_ATTRIBUTION=off only when attributionOff is requested (the Receptionist)', () => {
    const quest = buildRunEnv({ runId: 'r1', runKind: 'quest', passEnv: [], sourceEnv });
    expect(quest.TAGCONN_ATTRIBUTION).toBeUndefined();
    const receptionist = buildRunEnv({ runId: 'r1', runKind: 'receptionist', passEnv: [], attributionOff: true, sourceEnv });
    expect(receptionist.TAGCONN_ATTRIBUTION).toBe('off');
  });

  it('never carries any env the server might have sent - the function only ever reads sourceEnv/passEnv', () => {
    // The server never supplies env: this is a structural property (no server-provided parameter exists),
    // reasserted here so a future signature change is caught.
    expect(buildRunEnv.length).toBe(1);
  });
});
