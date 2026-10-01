import type { LifePose } from '../themes/types';

/** Hand prop per pose (texture keys; the new ones are painted by W1-12 in textures.ts). */
export const POSE_PROP: Record<LifePose, string | null> = {
  chat: null, sip: 'prop-cup', play: 'prop-controller', cheer: null, stretch: null, phone: 'prop-phone',
  water: 'prop-can', nap: null, doodle: 'prop-marker', sweep: 'prop-mop', carry: 'prop-parcel', sit: null,
};

/** Body animation per pose (pure data; `Character.animate` reads it while standing still).
 *  `handL`/`handR`: rest offsets of the hands from the feet-origin. `bob`: px a 2-3 Hz up-bounce of the upper body
 *  (0 = still; hands alternate by 1 px while it is > 0). `sway`: px of slow horizontal sway. `lie`: the upper body
 *  is rotated 90 degrees (nap). All offsets stay inside the 14x20 body box. */
export interface PoseAnim {
  handL: [number, number];
  handR: [number, number];
  bob: number;
  sway?: number;
  lie?: boolean;
}

export const POSE_ANIM: Record<LifePose, PoseAnim> = {
  chat: { handL: [-4, -4], handR: [5, -7], bob: 1 },
  sip: { handL: [-4, -4], handR: [4, -7], bob: 0 },
  play: { handL: [-2, -5], handR: [2, -5], bob: 1 },
  cheer: { handL: [-5, -11], handR: [5, -11], bob: 2 },
  stretch: { handL: [-6, -12], handR: [6, -12], bob: 0, sway: 1 },
  phone: { handL: [-4, -4], handR: [3, -9], bob: 0 },
  water: { handL: [-4, -4], handR: [5, -5], bob: 0, sway: 1 },
  nap: { handL: [-3, -4], handR: [3, -4], bob: 0, lie: true },
  doodle: { handL: [-4, -4], handR: [3, -5], bob: 1 },
  sweep: { handL: [-3, -5], handR: [4, -4], bob: 1, sway: 2 },
  carry: { handL: [-3, -6], handR: [3, -6], bob: 0 },
  sit: { handL: [-3, -4], handR: [3, -4], bob: 0 },
};
