import { describe, expect, it } from 'vitest';
import { SettingsSchema } from '@tagconn/shared';
import type { EncounterEvent } from '../../../game/npc/types';
import { shouldOfferEncounter, type EncounterRuleCtx } from '../encounterRules';

const settings = SettingsSchema.parse({ battle: { offerChance: 1 } });
const ev: EncounterEvent = { id: 'npc-1', kind: 'monster', style: 'modern', name: 'Slime', phase: 'appeared', at: 0 };
const ctx: EncounterRuleCtx = { settings, anyWaiting: false, canWrite: true, flowIdle: true, multiverse: false };

describe('shouldOfferEncounter', () => {
  it('offers when every condition holds', () => expect(shouldOfferEncounter(ev, ctx)).toBe(true));

  const blockers: [string, EncounterEvent, EncounterRuleCtx][] = [
    ['phase bit', { ...ev, phase: 'bit' }, ctx],
    ['phase left', { ...ev, phase: 'left' }, ctx],
    ['non-battle kind', { ...ev, kind: 'delivery' as never }, ctx],
    ['battle disabled', ev, { ...ctx, settings: SettingsSchema.parse({ battle: { enabled: false, offerChance: 1 } }) }],
    ['progression disabled', ev, { ...ctx, settings: SettingsSchema.parse({ battle: { offerChance: 1 }, progression: { enabled: false } }) }],
    ['alerts disabled', ev, { ...ctx, settings: SettingsSchema.parse({ battle: { offerChance: 1 }, office: { alerts: { enabled: false } } }) }],
    ['multiverse', ev, { ...ctx, multiverse: true }],
    ['flow busy', ev, { ...ctx, flowIdle: false }],
    ['agent waiting', ev, { ...ctx, anyWaiting: true }],
    ['read-only', ev, { ...ctx, canWrite: false }],
    ['offerChance 0', ev, { ...ctx, settings: SettingsSchema.parse({ battle: { offerChance: 0 } }) }],
  ];
  it.each(blockers)('%s alone blocks', (_n, e, c) => expect(shouldOfferEncounter(e, c)).toBe(false));

  it('the chance is seeded per npc id: same answer twice, and it splits across ids', () => {
    const half: EncounterRuleCtx = { ...ctx, settings: SettingsSchema.parse({ battle: { offerChance: 0.5 } }) };
    const ids = Array.from({ length: 200 }, (_, i) => `npc-${i}`);
    const first = ids.map((id) => shouldOfferEncounter({ ...ev, id }, half));
    expect(ids.map((id) => shouldOfferEncounter({ ...ev, id }, half))).toEqual(first);
    const n = first.filter(Boolean).length;
    expect(n).toBeGreaterThan(60);
    expect(n).toBeLessThan(140);
  });
});
