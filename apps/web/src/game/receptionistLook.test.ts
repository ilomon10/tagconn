import { describe, expect, it } from 'vitest';
import { receptionistLookKey } from './receptionistLook';

describe('receptionistLookKey', () => {
  it('is stable for equal inputs and changes with each input', () => {
    const base = receptionistLookKey('guild', false, true, 'Innkeeper', true);
    expect(receptionistLookKey('guild', false, true, 'Innkeeper', true)).toBe(base);
    for (const k of [
      receptionistLookKey('modern', false, true, 'Innkeeper', true),
      receptionistLookKey('guild', true, true, 'Innkeeper', true),
      receptionistLookKey('guild', false, false, 'Innkeeper', true),
      receptionistLookKey('guild', false, true, 'Concierge', true),
      receptionistLookKey('guild', false, true, 'Innkeeper', false),
    ]) expect(k).not.toBe(base);
  });
});
