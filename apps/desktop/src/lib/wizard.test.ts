import { describe, expect, it, vi } from 'vitest';
import type { SetupCheck, SetupFix } from '@tagconn/shared';
import { bannerChecks, blockingChecks, canAdvance, needsWizard, ownServerRunning, nextStep, prevStep, summarizeChecks, type WizardGate } from './wizard';
import { runFix, type FixEnv } from './fixes';
import { addFolder, removeFolder } from './paths';

const chk = (over: Partial<SetupCheck>): SetupCheck => ({ id: 'claude_cli', title: 't', status: 'ok', detail: 'd', required: true, ...over });
const gate = (over: Partial<WizardGate> = {}): WizardGate => ({ checks: [chk({})], checking: false, installResult: null, services: {}, ...over });

describe('wizard gating', () => {
  it('blocks the System check on a required failure only', () => {
    expect(canAdvance('check', gate())).toBe(true);
    expect(canAdvance('check', gate({ checks: [chk({ status: 'fail' })] }))).toBe(false);
    expect(canAdvance('check', gate({ checks: [chk({ status: 'fail', required: false }), chk({ id: 'docker', status: 'warn' })] }))).toBe(true);
    expect(canAdvance('check', gate({ checks: null }))).toBe(false);
    expect(canAdvance('check', gate({ checking: true }))).toBe(false);
  });

  it('needs an explicit install (or already-installed hooks) before continuing', () => {
    expect(canAdvance('hooks', gate())).toBe(false);
    expect(canAdvance('hooks', gate({ installResult: { changed: ['a'], backup: null } }))).toBe(true);
    expect(canAdvance('hooks', gate({ checks: [chk({ id: 'hooks', status: 'ok' })] }))).toBe(true);
  });

  it('needs the server (or docker) running to finish', () => {
    const running = { id: 'server', state: 'running', since: 1, restarts: 0 } as const;
    expect(canAdvance('start', gate())).toBe(false);
    expect(canAdvance('start', gate({ services: { server: running } }))).toBe(true);
    expect(canAdvance('start', gate({ services: { docker: { ...running, id: 'docker' } } }))).toBe(true);
    expect(canAdvance('done', gate())).toBe(false);
  });

  it('walks steps and clamps at the ends', () => {
    expect(nextStep('welcome')).toBe('check');
    expect(nextStep('done')).toBe('done');
    expect(prevStep('welcome')).toBe('welcome');
    expect(prevStep('hooks')).toBe('folders');
  });

  it('shows the wizard only until setup completed once', () => {
    expect(needsWizard(false)).toBe(true);
    expect(needsWizard(true)).toBe(false);
    expect(blockingChecks(null)).toEqual([]);
    expect(summarizeChecks([chk({}), chk({ status: 'warn' }), chk({ status: 'fail' })])).toEqual({ ok: 1, warn: 1, fail: 1 });
  });
});

describe('own server port', () => {
  const running = { id: 'server', state: 'running', since: 1, restarts: 0 } as const;
  const portFail = chk({ id: 'server_port', status: 'fail' });

  it('does not block on server_port while our server runs', () => {
    expect(blockingChecks([portFail])).toHaveLength(1);
    expect(blockingChecks([portFail], true)).toHaveLength(0);
    expect(blockingChecks([portFail, chk({ id: 'claude_cli', status: 'fail' })], true)).toHaveLength(1);
    expect(ownServerRunning({ server: running })).toBe(true);
    expect(ownServerRunning({ server: { ...running, state: 'stopped' } })).toBe(false);
    expect(canAdvance('check', gate({ checks: [portFail], services: { server: running } }))).toBe(true);
    expect(canAdvance('check', gate({ checks: [portFail] }))).toBe(false);
  });

  it('lists banner checks only after setup, never counting our own port', () => {
    expect(bannerChecks(false, [portFail], {})).toEqual([]);
    expect(bannerChecks(true, [portFail], {})).toEqual([portFail]);
    expect(bannerChecks(true, [portFail], { server: running })).toEqual([]);
  });
});

describe('fixes', () => {
  const env = (): FixEnv => ({
    recheck: vi.fn().mockResolvedValue(undefined),
    openUrl: vi.fn().mockResolvedValue(undefined),
    revealPath: vi.fn().mockResolvedValue(undefined),
    useNextFreePort: vi.fn().mockResolvedValue(undefined),
    chooseDataDir: vi.fn().mockResolvedValue(undefined),
    gotoHooks: vi.fn(),
    switchToNative: vi.fn().mockResolvedValue(undefined),
  });

  it('routes each action', async () => {
    const e = env();
    await runFix({ label: 'a', action: 'open_url', target: 'https://x' } as SetupFix, e);
    expect(e.openUrl).toHaveBeenCalledWith('https://x');
    await runFix({ label: 'a', action: 'open_file', target: '/p' }, e);
    expect(e.revealPath).toHaveBeenCalledWith('/p');
    await runFix({ label: 'a', action: 'install_hooks' }, e);
    expect(e.gotoHooks).toHaveBeenCalled();
    await runFix({ label: 'a', action: 'reinstall_app' }, e);
    expect(e.openUrl).toHaveBeenLastCalledWith(expect.stringContaining('github.com/ilomon10/tagconn'));
    for (const action of ['recheck', 'use_next_free_port', 'choose_data_dir', 'switch_to_native'] as const) await runFix({ label: 'a', action }, e);
    expect(e.recheck).toHaveBeenCalled();
    expect(e.switchToNative).toHaveBeenCalled();
  });

  it('refuses open_url without a target', async () => {
    await expect(runFix({ label: 'Open', action: 'open_url' }, env())).rejects.toThrow(/no target/);
  });
});

describe('folders', () => {
  it('adds without duplicates and removes', () => {
    expect(addFolder(['/a'], '/b')).toEqual(['/a', '/b']);
    expect(addFolder(['/a'], '/a')).toEqual(['/a']);
    expect(addFolder(['/a'], '  ')).toEqual(['/a']);
    expect(removeFolder(['/a', '/b'], '/a')).toEqual(['/b']);
  });
});
