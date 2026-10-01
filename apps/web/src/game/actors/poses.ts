import type { LifePose } from '../themes/types';

/** Hand prop per pose (texture keys; the new ones are painted by W1-12 in textures.ts). */
export const POSE_PROP: Record<LifePose, string | null> = {
  chat: null, sip: 'prop-cup', play: 'prop-controller', cheer: null, stretch: null, phone: 'prop-phone',
  water: 'prop-can', nap: null, doodle: 'prop-marker', sweep: 'prop-mop', carry: 'prop-parcel', sit: null,
};
