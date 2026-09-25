import * as Phaser from 'phaser';
import { OfficeScene, type OfficeFloorInfo, type OfficeFloorNeighbor, type OfficeState } from './scenes/OfficeScene';
import type { SafeInsets } from './camera/insets';

export type { OfficeFloorInfo, OfficeFloorNeighbor, OfficeState };

export type FloorNavDirection = 'up' | 'down';
type FloorNavListener = (dir: FloorNavDirection) => void;
const floorNavListeners = new Set<FloorNavListener>();

/**
 * A tiny command bus (docs/design/guild-hall.md section 6, item 7g) so a plain component — the top
 * bar's floor up/down buttons — can ask for the same animated stairs transition the in-scene stairs
 * use, without importing an `OfficeGame` instance. `OfficeView` is the sole subscriber: it already
 * owns the neighbor-resolution and transitioning/modal guards shared with the stairs and hotkeys.
 */
export const officeNavBus = {
  requestFloorNav(dir: FloorNavDirection) {
    floorNavListeners.forEach((cb) => cb(dir));
  },
  onFloorNavRequest(cb: FloorNavListener): () => void {
    floorNavListeners.add(cb);
    return () => floorNavListeners.delete(cb);
  },
};

type Events = {
  agentClick: (agentId: string) => void;
  /** A click (not a drag) that hit no character — the host closes the agent panel on this. */
  emptyClick: () => void;
  /** Follow was turned off from inside the scene (a manual drag started). */
  followChanged: (agentId: string | null) => void;
  /** A stairs portal was clicked. The host decides whether/where to move (see `lib/floors.ts`). */
  stairs: (dir: 'up' | 'down') => void;
  /** M8 8h: a Multiverse realm was clicked (docs/design/living-office.md section 6.3). The host
   *  travels to that project's floor; `null` for the overflow realm ("Other realms"), which opens
   *  the floor picker instead. */
  realmClick: (projectId: string | null) => void;
  /** M8 8b: the Guild Master's session-count chip was clicked (design section 5). The host opens
   *  `GmSessionsPopover` for this project. */
  gmSessions: (projectId: string) => void;
  /** M8 8c: a resting actor (no live agent right now) was clicked. The host opens the hero editor
   *  on this hero (design section 4.2's "clicking a resting actor opens the hero editor"). */
  heroClick: (heroId: string) => void;
};

/** Framework-agnostic handle around a Phaser.Game hosting the office scene. */
export class OfficeGame {
  private game: Phaser.Game;
  private scene: OfficeScene | null = null;
  private pending: OfficeState | null = null;
  private pendingInsets: SafeInsets | null = null;
  private destroyed = false;
  /** Set for the whole stairs transition, fade-out through fade-in (bug: re-entrancy). Callers
   *  (hotkeys, stairs clicks, top bar buttons) check this and no-op rather than stacking transitions. */
  private transitioning = false;
  private listeners: { [K in keyof Events]: Set<Events[K]> } = {
    agentClick: new Set(),
    emptyClick: new Set(),
    followChanged: new Set(),
    stairs: new Set(),
    realmClick: new Set(),
    gmSessions: new Set(),
    heroClick: new Set(),
  };

  constructor(parent: HTMLElement) {
    const scene = new OfficeScene((ready) => {
      if (this.destroyed) return;
      this.scene = ready;
      ready.events.on('agentClick', (id: string) => this.listeners.agentClick.forEach((cb) => cb(id)));
      ready.events.on('emptyClick', () => this.listeners.emptyClick.forEach((cb) => cb()));
      ready.events.on('followChanged', (id: string | null) => this.listeners.followChanged.forEach((cb) => cb(id)));
      ready.events.on('stairs', (dir: 'up' | 'down') => this.listeners.stairs.forEach((cb) => cb(dir)));
      ready.events.on('realmClick', (id: string | null) => this.listeners.realmClick.forEach((cb) => cb(id)));
      ready.events.on('gmSessions', (id: string) => this.listeners.gmSessions.forEach((cb) => cb(id)));
      ready.events.on('heroClick', (id: string) => this.listeners.heroClick.forEach((cb) => cb(id)));
      if (this.pending) ready.setOfficeState(this.pending);
      this.pending = null;
      if (this.pendingInsets) ready.setSafeInsets(this.pendingInsets);
      this.pendingInsets = null;
    });
    this.game = new Phaser.Game({
      type: Phaser.AUTO,
      parent,
      pixelArt: true,
      backgroundColor: '#15121e',
      scale: { mode: Phaser.Scale.RESIZE, width: parent.clientWidth || 800, height: parent.clientHeight || 600 },
      scene,
      banner: false,
      audio: { noAudio: true },
      input: { mouse: { preventDefaultWheel: true } },
    });
  }

  setState(state: OfficeState) {
    if (this.scene) this.scene.setOfficeState(state);
    else this.pending = state;
  }

  on<K extends keyof Events>(event: K, cb: Events[K]): () => void {
    this.listeners[event].add(cb);
    return () => this.listeners[event].delete(cb);
  }

  focus(agentId: string) {
    this.scene?.focusAgent(agentId);
  }

  /** Report the edges (CSS px) currently occupied by floating overlays, so the camera can pan any
   *  tile into the rect that's left over. Pass `ZERO_INSETS` when nothing is floating over the canvas. */
  setSafeInsets(insets: SafeInsets) {
    if (this.scene) this.scene.setSafeInsets(insets);
    else this.pendingInsets = insets;
  }

  /** Keep `agentId` centered in the safe rect while it moves; pass null to stop following. */
  setFollow(agentId: string | null) {
    this.scene?.setFollow(agentId);
  }

  /** The agent whose drawer is open in the host UI (M8 8d): it glows, and focus mode dims the
   *  rest (`office.focusDim`). Pass `null` when the panel is closed. */
  setSelected(agentId: string | null) {
    this.scene?.setSelected(agentId);
  }

  zoomBy(factor: number) {
    this.scene?.zoomBy(factor);
  }

  /** Pause rendering while the office is not visible. */
  setActive(active: boolean) {
    if (active) this.game.loop.wake();
    else this.game.loop.sleep();
  }

  resetView() {
    this.scene?.resetView();
  }

  /** Whether a stairs/floor transition is currently running (fade-out through fade-in). Hotkeys,
   *  stairs clicks and the top bar's floor buttons all check this and no-op while it's true. */
  get isTransitioning(): boolean {
    return this.transitioning;
  }

  /**
   * The stairs transition (docs/design/guild-hall.md section 6): fade out, call `swap` (the host
   * re-selects the floor, so React re-renders with the new project's agents/layout), fade back in.
   * Resolves once the fade-in has been kicked off; `ms <= 0` or reduced motion means no visual at
   * all, and `swap` runs immediately. No-ops (does not call `swap`) if a transition is already
   * running — the caller is expected to have checked `isTransitioning` already, but this is the
   * shared lock of last resort so a second trigger can never stack a transition mid-flight. `dir`
   * drives the 12px directional scroll only (omit it for a jump with no "up"/"down" sense).
   */
  async transitionFloor(ms: number, swap: () => void, dir?: FloorNavDirection): Promise<void> {
    if (this.transitioning) return;
    if (!this.scene) {
      swap();
      return;
    }
    this.transitioning = true;
    await this.scene.runTransition(ms, dir);
    swap();
    this.scene.finishTransition(ms, dir, () => {
      this.transitioning = false;
    });
  }

  destroy() {
    this.destroyed = true;
    this.listeners.agentClick.clear();
    this.listeners.emptyClick.clear();
    this.listeners.followChanged.clear();
    this.listeners.stairs.clear();
    this.listeners.realmClick.clear();
    this.listeners.gmSessions.clear();
    this.listeners.heroClick.clear();
    this.scene = null;
    this.game.destroy(true);
  }
}
