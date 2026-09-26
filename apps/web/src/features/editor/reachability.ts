import type { DoorSpec, LayoutRoom } from '@tagconn/shared';
import type { GeneratedMap, UnreachableReason } from '../../game/procgen';

/**
 * Reachability helpers (M8 8n, guild-hall.md section 5). The actual BFS-from-spawn verification
 * lives in the generator (`GeneratedMap.reachability`, computed alongside `issues`); this module
 * just adapts that report for the editor: human-readable reasons and door <-> `DoorSpec` conversion.
 */
export const REASON_LABEL: Record<UnreachableReason, string> = {
  sealed: 'sealed — no doors',
  'blocked-by-furniture': 'blocked by furniture',
  'no-corridor': 'no corridor reaches it',
};

/** Every door currently opened on this room's wall ring that the generator placed automatically
 * (`room.doors` was left `undefined`), as `DoorSpec`s. Used both to render "auto" doors (dashed) and,
 * on the first edit, to materialize them into an explicit `LayoutRoom.doors` list so nothing jumps —
 * see `editorStore.ensureExplicitDoors`. Deduplicated by (side, offset, width): defensive against a
 * generator that reports one `Door` per wall tile rather than one per opening — either way each
 * distinct door is only materialized once. */
export function autoDoorsForRoom(map: GeneratedMap, room: Pick<LayoutRoom, 'id'>): DoorSpec[] {
  const seen = new Set<string>();
  const specs: DoorSpec[] = [];
  for (const d of map.doors) {
    if (d.roomId !== room.id || !d.auto) continue;
    const k = `${d.side}:${d.offset}:${d.width}`;
    if (seen.has(k)) continue;
    seen.add(k);
    specs.push({ side: d.side, offset: d.offset, width: d.width });
  }
  return specs;
}
