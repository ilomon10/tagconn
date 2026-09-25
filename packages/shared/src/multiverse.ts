import type { OfficeLayout, OfficeStyle, TileRect } from './layout.js';

/**
 * The Multiverse floor (M8 8h). It replaces the "All floors" view: a virtual floor (not a project)
 * whose layout the web generates from the live projects, with a central Nexus and one realm per
 * project joined by rift corridors. Nothing here is stored by the server; these types are the
 * contract between the web's plan generator (`game/multiverse/`) and the scene / React bridge.
 * See docs/design/living-office.md section 6.
 */

/** The floor id of the Multiverse. Deliberately equal to the '*' (all projects) subscription. */
export const MULTIVERSE_FLOOR_ID = '*';

/** Id of the generated layout. `layouts` rejects saving a layout under this id (reserved). */
export const MULTIVERSE_LAYOUT_ID = 'multiverse';

/** Web theme used for the Nexus, the void and the rift corridors. Not a user-selectable `OfficeStyle`. */
export const MULTIVERSE_THEME_ID = 'rift';

export const MULTIVERSE_LIMITS = {
  /** Geometry ceiling (a 4x4 grid with a 2x2 Nexus has 12 perimeter cells). `office.multiverseMaxRealms` is capped here. */
  maxRealms: 12,
  /** Ceiling for `office.multiverseMaxCharacters`. */
  maxCharacters: 120,
  /** One realm cell in tiles (the realm block plus a void margin for rift corridors). */
  cellWidth: 30,
  cellHeight: 22,
  /** Rooms per realm in the reference template; 12 realms plus 2 Nexus rooms stay within LAYOUT_LIMITS.maxRooms (64). */
  roomsPerRealm: 5,
  /** Total animated ambient objects (motes, aurora, torches) across all regions. */
  maxAmbientObjects: 150,
} as const;

/** What the plan generator needs to know per project. */
export interface MultiverseProjectInput {
  id: string;
  name: string;
  /** The project's resolved style: its layout's `style`, else `settings.office.style`. */
  style: OfficeStyle;
  createdAt: number;
  lastActivityAt: number;
  /** Live (not removed, not done) agents on the floor right now. */
  liveAgents: number;
  /** Last time the web saw a live agent here (keeps a realm for `office.idleLeaveSec` after it empties). */
  lastLiveAt: number;
}

export interface MultiverseRealm {
  /** Index into `MultiversePlan.realms`; also the room id prefix (`r<index>-`). */
  index: number;
  /** Projects shown in this realm: exactly one, or several for the overflow realm. */
  projectIds: string[];
  /** True for the "Other realms" realm that groups everything past `maxRealms - 1`. */
  overflow: boolean;
  /** Banner text: the project name, or "Other realms (N)". */
  name: string;
  /** Painted with this project's style; the overflow realm uses the rift theme (`null`). */
  style: OfficeStyle | null;
  /** The grid cell painted with `style` (tiles). Everything outside realm cells uses the rift theme. */
  cell: TileRect;
  /** Room ids of this realm inside `MultiversePlan.layout`. */
  roomIds: string[];
  /** Tile where the realm banner is drawn (above the realm block). */
  bannerAt: { x: number; y: number };
}

export interface MultiversePlan {
  /** Stable key: the scene rebuilds the world only when this changes (realm ids in order + styles). */
  key: string;
  /** A regular layout (id `MULTIVERSE_LAYOUT_ID`, background `void`); `validateLayout` reports no errors. */
  layout: OfficeLayout;
  /** The Nexus area (entrance plaza plus the stairs landing). */
  nexus: TileRect;
  realms: MultiverseRealm[];
  /** projectId → index in `realms` (overflow members point at the overflow realm). */
  realmByProject: Record<string, number>;
}
