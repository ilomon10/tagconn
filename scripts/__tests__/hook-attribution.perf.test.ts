// Timing/perf-budget tests split out of hook-attribution.test.ts: these assert real
// elapsed wall-clock time against a budget (unlike the functional tests in that file),
// which flakes on a loaded machine, so they run separately via `pnpm test:perf`.
// See docs/design/runner-and-helpdesk.md §6.2 and packages/hook/office-hook.sh.
import { beforeAll, describe, expect, it } from 'vitest';
import { createHookSandbox, makeFakeCurlBin, runHook as runHookWith, type HookSandbox } from './support/hook-harness.ts';

let binDir: string;

beforeAll(() => {
  binDir = makeFakeCurlBin();
});

function runHook(sandbox: HookSandbox, body: unknown, extraEnv: NodeJS.ProcessEnv = {}) {
  return runHookWith(binDir, sandbox, body, extraEnv);
}

describe('SC4 hardening: perf gate for the hook_event_name check (M1)', () => {
  it('stays fast on a large non-SessionStart body (no sed forked over megabytes of data)', async () => {
    const sandbox = createHookSandbox();
    // No attribution-README.md / attribution.conf installed, so this only
    // exercises the foreground POST + the is_session_start gate - exactly
    // the path that used to fork `sed` over the whole body on every event.
    const bigBody = { session_id: 's', hook_event_name: 'PostToolUse', tool_response: 'x'.repeat(8_000_000) };
    const start = Date.now();
    const res = runHook(sandbox, bigBody);
    const elapsedMs = Date.now() - start;
    expect(res.status).toBe(0);
    // Generous budget (CI can be slow) but meaningful: the regression this
    // guards against measured ~1.2s for an 8MB body; a healthy run is a few
    // hundred ms (dominated by piping 8MB through the fake curl itself).
    expect(elapsedMs).toBeLessThan(1000);
  });

  it('also stays fast when the body contains the literal string "SessionStart" but is large', async () => {
    const sandbox = createHookSandbox();
    const bigBody = {
      session_id: 's',
      hook_event_name: 'PostToolUse',
      tool_response: `mentions SessionStart once, then: ${'x'.repeat(8_000_000)}`,
    };
    const start = Date.now();
    const res = runHook(sandbox, bigBody);
    const elapsedMs = Date.now() - start;
    expect(res.status).toBe(0);
    expect(elapsedMs).toBeLessThan(1000);
  });
});
