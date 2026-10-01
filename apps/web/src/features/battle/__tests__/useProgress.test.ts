import { describe, expect, it } from 'vitest';
import { SettingsSchema, type HeroProgress } from '@tagconn/shared';
import { agentLevelFor, wakeDelay } from '../useProgress';

const settings = (over: Record<string, unknown> = {}) => SettingsSchema.parse({ progression: over });
const prog = { level: 12 } as HeroProgress;
const usage = { messages: 1, contextTokens: 0, inputTokens: 0, outputTokens: 6000, cacheReadTokens: 0, cacheCreationTokens: 0 };

describe('agentLevelFor', () => {
  it('is null when progression is disabled', () => {
    expect(agentLevelFor({ usage }, { id: 'h-aaaaaaaa' }, prog, settings({ enabled: false }))).toBeNull();
    expect(agentLevelFor({ usage }, undefined, undefined, settings({ enabled: false }))).toBeNull();
  });
  it('shows a hero its stored level (1 before a row exists)', () => {
    expect(agentLevelFor({}, { id: 'h-aaaaaaaa' }, prog, settings())).toEqual({ level: 12, temporary: false });
    expect(agentLevelFor({}, { id: 'h-aaaaaaaa' }, undefined, settings())).toEqual({ level: 1, temporary: false });
  });
  it('gives an anonymous agent a temporary level from usage, or null without usage', () => {
    const r = agentLevelFor({ usage }, undefined, undefined, settings());
    expect(r?.temporary).toBe(true);
    expect(r?.level).toBeGreaterThanOrEqual(1);
    expect(agentLevelFor({}, undefined, undefined, settings())).toBeNull();
    expect(agentLevelFor({ usage: { ...usage, outputTokens: 0 } }, undefined, undefined, settings())).toBeNull();
  });
});

describe('wakeDelay', () => {
  it('is null for no/past target, else ms to it and clamped', () => {
    expect(wakeDelay(null, 100)).toBeNull();
    expect(wakeDelay(undefined, 100)).toBeNull();
    expect(wakeDelay(100, 100)).toBeNull();
    expect(wakeDelay(150, 100)).toBe(51);
    expect(wakeDelay(1e15, 0)).toBe(2 ** 31 - 1);
  });
});
