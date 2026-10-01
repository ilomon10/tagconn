import { describe, expect, it } from 'vitest';
import type { LifePose } from '../../themes/types';
import { POSE_ANIM, POSE_PROP } from '../poses';

const ALL: LifePose[] = ['chat', 'sip', 'play', 'cheer', 'stretch', 'phone', 'water', 'nap', 'doodle', 'sweep', 'carry', 'sit'];

describe('poses', () => {
  it('POSE_PROP and POSE_ANIM are total over LifePose', () => {
    expect(Object.keys(POSE_PROP).sort()).toEqual([...ALL].sort());
    expect(Object.keys(POSE_ANIM).sort()).toEqual([...ALL].sort());
  });

  it('keeps hand offsets inside the 14x20 body box', () => {
    for (const pose of ALL) {
      const a = POSE_ANIM[pose];
      for (const [x, y] of [a.handL, a.handR]) {
        expect(Math.abs(x)).toBeLessThanOrEqual(7);
        expect(y).toBeGreaterThanOrEqual(-18);
        expect(y).toBeLessThanOrEqual(2);
      }
      expect(a.bob).toBeGreaterThanOrEqual(0);
      expect(a.bob).toBeLessThanOrEqual(2);
    }
  });

  it('only nap lies down; prop poses keep their textures', () => {
    expect(ALL.filter((p) => POSE_ANIM[p].lie)).toEqual(['nap']);
    expect(POSE_PROP.sip).toBe('prop-cup');
    expect(POSE_PROP.nap).toBeNull();
  });
});
