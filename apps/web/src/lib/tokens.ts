import type { Agent, TokenUsage } from '@tagconn/shared';

/**
 * Approximate context window by model family. Anthropic doesn't put this in the usage payload,
 * so this is a web-local guess used only to size the context bar — not a server setting.
 */
const CONTEXT_WINDOWS: Record<string, number> = {
  opus: 200_000,
  sonnet: 200_000,
  haiku: 200_000,
};
export const DEFAULT_CONTEXT_WINDOW = 200_000;

/** Best-effort context window for a model id like "claude-sonnet-5" or "claude-opus-4-1-20250805". */
export function contextWindowFor(model?: string): number {
  if (!model) return DEFAULT_CONTEXT_WINDOW;
  const m = model.toLowerCase();
  if (m.includes('1m')) return 1_000_000;
  for (const [family, size] of Object.entries(CONTEXT_WINDOWS)) if (m.includes(family)) return size;
  return DEFAULT_CONTEXT_WINDOW;
}

/** 0..1 fill ratio of the context window, clamped. */
export function contextRatio(usage: TokenUsage | undefined): number {
  if (!usage || usage.contextTokens <= 0) return 0;
  return Math.min(1, usage.contextTokens / contextWindowFor(usage.model));
}

/** Tokens counted against the subscription plan (no per-token dollar cost to show). */
export const totalTokens = (u: TokenUsage): number => u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreationTokens;

const sumCounts = (usages: (TokenUsage | undefined)[]) =>
  usages.filter((u): u is TokenUsage => !!u).reduce(
    (acc, u) => ({
      inputTokens: acc.inputTokens + u.inputTokens,
      outputTokens: acc.outputTokens + u.outputTokens,
      cacheReadTokens: acc.cacheReadTokens + u.cacheReadTokens,
      cacheCreationTokens: acc.cacheCreationTokens + u.cacheCreationTokens,
      messages: acc.messages + u.messages,
    }),
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, messages: 0 },
  );

/**
 * Sum over one session's main agent + all its subagents. Matches the server's semantics exactly
 * (`transcripts.service.ts`'s `sumUsage`): the four counted fields add up, but `contextTokens`/`model`
 * come from the main agent alone — a subagent's own context window isn't part of the main
 * conversation's context, so summing it in would overstate how full the session's context is.
 */
export function sumUsage(agents: Pick<Agent, 'isMain' | 'usage'>[]): TokenUsage {
  const totals = sumCounts(agents.map((a) => a.usage));
  const main = agents.find((a) => a.isMain)?.usage;
  return { ...totals, contextTokens: main?.contextTokens ?? 0, model: main?.model };
}

/**
 * Sum over usage from *independent* sessions (e.g. every active session on a floor). Unlike
 * `sumUsage`, `contextTokens` is never summed across sessions — each session's context window is its
 * own, unrelated conversation, so adding them together would be a meaningless number. Instead this
 * reports the largest single session's context, which is at least a sane "worst case" to show.
 */
export function sumFloorUsage(usages: (TokenUsage | undefined)[]): TokenUsage {
  const totals = sumCounts(usages);
  const contextTokens = usages.reduce((max, u) => Math.max(max, u?.contextTokens ?? 0), 0);
  return { ...totals, contextTokens };
}
