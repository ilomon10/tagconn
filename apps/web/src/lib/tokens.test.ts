import { describe, expect, it } from 'vitest';
import type { Agent, TokenUsage } from '@tagconn/shared';
import { contextRatio, contextWindowFor, sumFloorUsage, sumUsage, totalTokens } from './tokens';

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

const agent = (over: Partial<Pick<Agent, 'isMain' | 'usage'>> = {}): Pick<Agent, 'isMain' | 'usage'> => ({ isMain: false, usage: usage(), ...over });

describe('sumUsage (one session: main agent + its subagents)', () => {
  it('sums the four counted fields across every agent, but takes contextTokens/model from the main agent only', () => {
    const main = agent({ isMain: true, usage: usage({ contextTokens: 175, model: 'claude-opus-5' }) });
    const sub = agent({ isMain: false, usage: usage({ inputTokens: 10, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, messages: 1, contextTokens: 999_999, model: 'claude-haiku-4' }) });
    const sum = sumUsage([main, sub]);
    expect(sum).toEqual({
      inputTokens: 110,
      outputTokens: 200,
      cacheReadTokens: 50,
      cacheCreationTokens: 25,
      messages: 4,
      contextTokens: 175, // the main agent's, never the subagent's 999_999
      model: 'claude-opus-5',
    });
  });

  it('ignores agents with no usage yet', () => {
    const sum = sumUsage([agent({ isMain: true, usage: undefined }), agent({ isMain: false, usage: usage() })]);
    expect(sum).toMatchObject({ inputTokens: 100, contextTokens: 0, model: undefined });
  });

  it('returns zeroed usage (contextTokens 0, no model) for an empty list or no main agent', () => {
    expect(sumUsage([])).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, messages: 0, contextTokens: 0, model: undefined });
    expect(sumUsage([agent({ isMain: false })]).contextTokens).toBe(0);
  });
});

describe('sumFloorUsage (independent sessions on a floor)', () => {
  it('sums the four counted fields across sessions, but takes contextTokens as the largest single session, never their sum', () => {
    const sum = sumFloorUsage([usage({ contextTokens: 175 }), undefined, usage({ inputTokens: 10, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, messages: 1, contextTokens: 900_000 })]);
    expect(sum).toEqual({
      inputTokens: 110,
      outputTokens: 200,
      cacheReadTokens: 50,
      cacheCreationTokens: 25,
      messages: 4,
      contextTokens: 900_000, // the larger of the two sessions', not 175 + 900_000
    });
  });

  it('returns zeroed usage for an empty list', () => {
    expect(sumFloorUsage([])).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, messages: 0, contextTokens: 0 });
  });
});
