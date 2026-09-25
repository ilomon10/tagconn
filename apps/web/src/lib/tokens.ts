import type { TokenUsage } from '@tagconn/shared';

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

const emptyUsage = (): TokenUsage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, messages: 0, contextTokens: 0 });

/** Sum over the main agent and all its subagents — same semantics as Session.usage (see domain.ts). */
export function sumUsage(usages: (TokenUsage | undefined)[]): TokenUsage {
  return usages.filter((u): u is TokenUsage => !!u).reduce<TokenUsage>(
    (acc, u) => ({
      inputTokens: acc.inputTokens + u.inputTokens,
      outputTokens: acc.outputTokens + u.outputTokens,
      cacheReadTokens: acc.cacheReadTokens + u.cacheReadTokens,
      cacheCreationTokens: acc.cacheCreationTokens + u.cacheCreationTokens,
      messages: acc.messages + u.messages,
      contextTokens: acc.contextTokens + u.contextTokens,
      model: acc.model ?? u.model,
    }),
    emptyUsage(),
  );
}
