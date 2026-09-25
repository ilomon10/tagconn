import * as Phaser from 'phaser';
import { OfficeScene, type OfficeFloorInfo, type OfficeFloorNeighbor, type OfficeState } from './scenes/OfficeScene';
import type { SafeInsets } from './camera/insets';

export type { OfficeFloorInfo, OfficeFloorNeighbor, OfficeState };

type Events = {
  agentClick: (agentId: string) => void;
  /** A click (not a drag) that hit no character — the host closes the agent panel on this. */
  emptyClick: () => void;
  /** Follow was turned off from inside the scene (a manual drag started). */
  followChanged: (agentId: string | null) => void;
  /** A stairs portal was clicked. The host decides whether/where to move (see `lib/floors.ts`). */
  stairs: (dir: 'up' | 'down') => void;
};

/** Framework-agnostic handle around a Phaser.Game hosting the office scene. */
export class OfficeGame {
  private game: Phaser.Game;
  private scene: OfficeScene | null = null;
  private pending: OfficeState | null = null;
  private pendingInsets: SafeInsets | null = null;
  private destroyed = false;
  private listeners: { [K in keyof Events]: Set<Events[K]> } = {
    agentClick: new Set(),
    emptyClick: new Set(),
    followChanged: new Set(),
    stairs: new Set(),
  };

  constructor(parent: HTMLElement) {
    const scene = new OfficeScene((ready) => {
      if (this.destroyed) return;
      this.scene = ready;
      ready.events.on('agentClick', (id: string) => this.listeners.agentClick.forEach((cb) => cb(id)));
      ready.events.on('emptyClick', () => this.listeners.emptyClick.forEach((cb) => cb()));
      ready.events.on('followChanged', (id: string | null) => this.listeners.followChanged.forEach((cb) => cb(id)));
      ready.events.on('stairs', (dir: 'up' | 'down') => this.listeners.stairs.forEach((cb) => cb(dir)));
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

  /**
   * The stairs transition (docs/design/guild-hall.md section 6): fade out, call `swap` (the host
   * re-selects the floor, so React re-renders with the new project's agents/layout), fade back in.
   * Resolves once the fade-in has been kicked off; `ms <= 0` or reduced motion means no visual at
   * all, and `swap` runs immediately.
   */
  async transitionFloor(ms: number, swap: () => void): Promise<void> {
    if (!this.scene) {
      swap();
      return;
    }
    await this.scene.runTransition(ms);
    swap();
    this.scene.finishTransition(ms);
  }

  destroy() {
    this.destroyed = true;
    this.listeners.agentClick.clear();
    this.listeners.emptyClick.clear();
    this.listeners.followChanged.clear();
    this.listeners.stairs.clear();
    this.scene = null;
    this.game.destroy(true);
  }
}
