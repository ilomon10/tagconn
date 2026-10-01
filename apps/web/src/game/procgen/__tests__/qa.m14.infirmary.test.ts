import { describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT } from '@tagconn/shared';
import { generateMap } from '../index';
import { TRIGGER_KINDS } from '../../furnitureTriggers';

// QA M14 finding (fixed): the coffee-break heal (docs/design/battles.md T1) needs a coffee-machine / water-cooler.
// The trigger pass now places a coffee machine when a floor has none, so the default floor can always heal early.
describe('QA M14: coffee-break heal reachability', () => {
  it('the default floor has at least one coffee-machine or water-cooler to click, marked infirmary', () => {
    const map = generateMap(DEFAULT_LAYOUT);
    const kinds = new Set<string>(TRIGGER_KINDS.infirmary);
    expect(map.furniture.filter((f) => kinds.has(f.kind)).length).toBeGreaterThan(0);
    const marked = map.furniture.filter((f) => f.trigger === 'infirmary');
    expect(marked).toHaveLength(1);
    expect(marked[0]).toMatchObject({ blocking: true, w: 1, h: 1 });
  });
});
