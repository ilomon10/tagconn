import { NPC_KINDS } from '@tagconn/shared';
import { describe, expect, it } from 'vitest';
import { ENCOUNTERS } from '../encounters';

describe('ENCOUNTERS', () => {
  it('defines every NpcKind with a 24-entry hour curve and enter..exit steps', () => {
    for (const k of NPC_KINDS) {
      const d = ENCOUNTERS[k];
      expect(d.kind).toBe(k);
      expect(d.hours).toHaveLength(24);
      expect(d.steps[0]).toEqual({ do: 'enter' });
      expect(d.steps[d.steps.length - 1]).toEqual({ do: 'exit' });
    }
  });
  it('marks routine kinds and wraps night curves', () => {
    expect(NPC_KINDS.filter((k) => ENCOUNTERS[k].routine).sort()).toEqual(['courier', 'janitor', 'plant-waterer']);
    expect(ENCOUNTERS['cia-agent'].hours[23]).toBe(1);
    expect(ENCOUNTERS['cia-agent'].hours[2]).toBe(1);
    expect(ENCOUNTERS['cia-agent'].hours[12]).toBe(0);
    expect(ENCOUNTERS['office-cat'].hours[3]).toBe(2 * (ENCOUNTERS['office-cat'].hours[12] ?? 0));
  });
});
