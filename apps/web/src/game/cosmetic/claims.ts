// M13 W1-11: the shared registry that makes a character part of at most one cosmetic script (drama, life, reactions)
// (docs/design/office-life.md sections 2.3 and 3.4). Pure bookkeeping: it never touches a character.
import type { ActorKey } from '../cast';
import type { Point } from '../procgen/types';
import { CLAIM_PRIORITY, type ClaimKind, type CosmeticClaimsApi } from './types';

interface Claim {
  kind: ClaimKind;
  onRevoke: (key: ActorKey) => void;
}

const tileKey = (p: Point) => `${p.x},${p.y}`;

export class CosmeticClaims implements CosmeticClaimsApi {
  private claims = new Map<ActorKey, Claim>();
  private tiles = new Map<string, ClaimKind>();

  tryClaim(key: ActorKey, kind: ClaimKind, onRevoke: (key: ActorKey) => void): boolean {
    const held = this.claims.get(key);
    if (held) {
      if (CLAIM_PRIORITY[held.kind] >= CLAIM_PRIORITY[kind]) return false;
      // Drop the old claim first so a revoke handler that releases (or re-enters) sees a consistent registry.
      this.claims.delete(key);
      held.onRevoke(key);
      // A handler must not retake the key; if it somehow did, the higher priority claim still wins below.
    }
    this.claims.set(key, { kind, onRevoke });
    return true;
  }

  release(key: ActorKey, kind: ClaimKind): void {
    if (this.claims.get(key)?.kind === kind) this.claims.delete(key);
  }

  holder(key: ActorKey): ClaimKind | undefined {
    return this.claims.get(key)?.kind;
  }

  isFree(key: ActorKey): boolean {
    return !this.claims.has(key);
  }

  reserveTile(p: Point, kind: ClaimKind): boolean {
    const k = tileKey(p);
    if (this.tiles.has(k)) return false;
    this.tiles.set(k, kind);
    return true;
  }

  releaseTile(p: Point, kind: ClaimKind): void {
    const k = tileKey(p);
    if (this.tiles.get(k) === kind) this.tiles.delete(k);
  }

  isTileReserved(p: Point): boolean {
    return this.tiles.has(tileKey(p));
  }

  count(kind?: ClaimKind): number {
    if (!kind) return this.claims.size;
    let n = 0;
    for (const c of this.claims.values()) if (c.kind === kind) n++;
    return n;
  }

  clear(): void {
    this.claims.clear();
    this.tiles.clear();
  }
}
