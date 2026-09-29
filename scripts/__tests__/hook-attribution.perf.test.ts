// Timing/perf-budget tests split out of hook-attribution.test.ts: these assert real
// elapsed wall-clock time against a budget (unlike the functional tests in that file),
// which flakes on a loaded machine, so they run separately via `pnpm test:perf`.
// See docs/design/runner-and-helpdesk.md §6.2, packages/hook/office-hook.sh and office-hook.mjs.
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createHookSandbox,
  HOOK_KINDS,
  type HookKind,
  type HookSandbox,
  makeFakeCurlBin,
  runHook as runHookWith,
} from './support/hook-harness.ts';

let binDir: string;

beforeAll(() => {
  binDir = makeFakeCurlBin();
});

const opened: HookSandbox[] = [];
afterEach(async () => {
  for (const sb of opened.splice(0)) await sb.server?.close();
});

async function sandboxFor(kind: HookKind): Promise<HookSandbox> {
  const sb = await createHookSandbox(kind);
  opened.push(sb);
  return sb;
}

function runHook(sandbox: HookSandbox, body: unknown, extraEnv: NodeJS.ProcessEnv = {}) {
  return runHookWith(binDir, sandbox, body, extraEnv);
}

describe.each(HOOK_KINDS)('SC4 hardening: perf gate for the hook_event_name check (M1) [%s]', (kind) => {
  it('stays fast on a large non-SessionStart body (no sed forked over megabytes of data)', async () => {
    const sandbox = await sandboxFor(kind);
    // No attribution-README.md / attribution.conf installed, so this only
    // exercises the foreground POST + the is_session_start gate - exactly
    // the path that used to fork `sed` over the whole body on every event.
    const bigBody = { session_id: 's', hook_event_name: 'PostToolUse', tool_response: 'x'.repeat(8_000_000) };
    const res = await runHook(sandbox, bigBody);
    expect(res.status).toBe(0);
    // Generous budget (CI can be slow) but meaningful: the regression this
    // guards against measured ~1.2s for an 8MB body; a healthy run is a few
    // hundred ms (dominated by piping 8MB through the fake curl itself).
    expect(res.elapsedMs).toBeLessThan(1000);
  });

  it('also stays fast when the body contains the literal string "SessionStart" but is large', async () => {
    const sandbox = await sandboxFor(kind);
    const bigBody = {
      session_id: 's',
      hook_event_name: 'PostToolUse',
      tool_response: `mentions SessionStart once, then: ${'x'.repeat(8_000_000)}`,
    };
    const res = await runHook(sandbox, bigBody);
    expect(res.status).toBe(0);
    expect(res.elapsedMs).toBeLessThan(1000);
  });
});

describe('node hook latency budget', () => {
  it('p50 < 60 ms per event against a local server', async () => {
    const sandbox = await sandboxFor('node');
    const body = { session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Bash' };
    await runHook(sandbox, body); // warm the file cache
    const samples: number[] = [];
    for (let i = 0; i < 21; i++) samples.push((await runHook(sandbox, body)).elapsedMs);
    samples.sort((a, b) => a - b);
    const p50 = samples[Math.floor(samples.length / 2)] ?? Infinity;
    expect(sandbox.server?.requests.length).toBe(22);
    expect(p50).toBeLessThan(60);
  });
});
