import { describe, expect, it } from 'vitest';
import { MULTIVERSE_THEME_ID } from '@tagconn/shared';
import { gradingForStyle } from '../grading';

describe('gradingForStyle', () => {
  it('gives modern a warm, desaturated cozy grade', () => {
    const p = gradingForStyle('modern');
    expect(p.warmth).toBeGreaterThan(0);
    expect(p.saturation).toBeLessThan(1);
  });

  it('gives guild a candlelit amber grade with cool (blue-lifted) shadows', () => {
    const p = gradingForStyle('guild');
    expect(p.warmth).toBeGreaterThan(0);
    expect(p.gain[0]).toBeGreaterThan(p.gain[2]); // amber highlights: red gain > blue gain
    expect(p.lift[2]).toBeGreaterThan(p.lift[0]); // shadows tilt blue, not red
  });

  it('gives the rift a cool teal/violet grade', () => {
    const p = gradingForStyle(MULTIVERSE_THEME_ID);
    expect(p.warmth).toBeLessThan(0);
    expect(p.gain[2]).toBeGreaterThan(p.gain[0]); // blue/violet gain > red gain
  });

  it('every preset is distinct (no two styles read the same)', () => {
    const modern = gradingForStyle('modern');
    const guild = gradingForStyle('guild');
    const rift = gradingForStyle(MULTIVERSE_THEME_ID);
    expect(modern).not.toEqual(guild);
    expect(guild).not.toEqual(rift);
    expect(modern).not.toEqual(rift);
  });
});
