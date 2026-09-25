import { describe, expect, it } from 'vitest';
import type { TokenUsage } from '@tagconn/shared';
import { contextRatio, contextWindowFor, sumUsage, totalTokens } from './tokens';

const usage = (over: Partial<TokenUsage> = {}): TokenUsage => ({
  inputTokens: 100,
  outputTokens: 200,
  cacheReadTokens: 50,
  cacheCreationTokens: 25,
  messages: 3,
  contextTokens: 175,
  ...over,
});

describe('contextWindowFor', () => {
  it('defaults to 200k for unknown or missing models', () => {
    expect(contextWindowFor(undefined)).toBe(200_000);
    expect(contextWindowFor('some-future-model')).toBe(200_000);
  });

  it('recognizes known model families', () => {
    expect(contextWindowFor('claude-sonnet-5')).toBe(200_000);
    expect(contextWindowFor('claude-opus-4-1-20250805')).toBe(200_000);
    expect(contextWindowFor('claude-haiku-4')).toBe(200_000);
  });

  it('recognizes a 1M-context variant', () => {
    expect(contextWindowFor('claude-sonnet-4-5[1m]')).toBe(1_000_000);
  });
});

describe('contextRatio', () => {
  it('is 0 for missing or empty usage', () => {
    expect(contextRatio(undefined)).toBe(0);
    expect(contextRatio(usage({ contextTokens: 0 }))).toBe(0);
  });

  it('divides by the model context window and clamps to 1', () => {
    expect(contextRatio(usage({ contextTokens: 100_000, model: 'claude-sonnet-5' }))).toBe(0.5);
    expect(contextRatio(usage({ contextTokens: 500_000, model: 'claude-sonnet-5' }))).toBe(1);
  });
});

describe('totalTokens', () => {
  it('sums the four counted fields', () => {
    expect(totalTokens(usage())).toBe(100 + 200 + 50 + 25);
  });
});

describe('sumUsage', () => {
  it('sums numeric fields and ignores missing entries', () => {
    const sum = sumUsage([usage(), undefined, usage({ inputTokens: 10, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, messages: 1, contextTokens: 10 })]);
    expect(sum).toEqual({
      inputTokens: 110,
      outputTokens: 200,
      cacheReadTokens: 50,
      cacheCreationTokens: 25,
      messages: 4,
      contextTokens: 185,
      model: undefined,
    });
  });

  it('returns zeroed usage for an empty list', () => {
    expect(sumUsage([])).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, messages: 0, contextTokens: 0 });
  });

  it('keeps the first defined model', () => {
    const sum = sumUsage([usage({ model: undefined }), usage({ model: 'claude-sonnet-5' }), usage({ model: 'claude-haiku-4' })]);
    expect(sum.model).toBe('claude-sonnet-5');
  });
});
