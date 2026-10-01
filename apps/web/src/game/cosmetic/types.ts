import type { ActorKey } from '../cast';
import type { Point } from '../procgen/types';

/** Higher preempts lower; equal never preempts. */
export const CLAIM_PRIORITY = { drama: 1, activity: 1, reaction: 2, meeting: 3 } as const;
export type ClaimKind = keyof typeof CLAIM_PRIORITY;
/** Script spots and NPC targets keep this Chebyshev distance from waiting/blocked characters. */
export const WAITING_CLEARANCE_TILES = 2;

export interface CosmeticClaimsApi {
  /** Free: claims. Held by a lower priority: calls that holder's onRevoke(key) synchronously, then claims.
   *  Held by the same or a higher priority: false. */
  tryClaim(key: ActorKey, kind: ClaimKind, onRevoke: (key: ActorKey) => void): boolean;
  /** No-op unless `kind` holds `key`. */
  release(key: ActorKey, kind: ClaimKind): void;
  holder(key: ActorKey): ClaimKind | undefined;
  isFree(key: ActorKey): boolean;
  /** False when any kind already reserved the tile. */
  reserveTile(p: Point, kind: ClaimKind): boolean;
  releaseTile(p: Point, kind: ClaimKind): void;
  isTileReserved(p: Point): boolean;
  /** Claimed characters (of one kind, or all). */
  count(kind?: ClaimKind): number;
  /** buildWorld / floor change: drop everything, no callbacks. */
  clear(): void;
}
