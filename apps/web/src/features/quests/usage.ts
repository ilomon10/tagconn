import type { RunUsage } from '@tagconn/shared';

/** Tokens counted against the subscription plan for one run's result — same four fields as
 *  `lib/tokens.ts`'s `totalTokens`, but `RunUsage` (the runner's shape) has no `messages` field. */
export const sumRunUsage = (u: RunUsage): number => u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreationTokens;
