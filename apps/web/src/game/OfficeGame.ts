import * as Phaser from 'phaser';
import type { Agent, Role, Settings } from '@tagconn/shared';
import { OfficeScene, type OfficeState } from './scenes/OfficeScene';

type Events = { agentClick: (agentId: string) => void };

/** Framework-agnostic handle around a Phaser.Game hosting the office scene. */
export class OfficeGame {
  private game: Phaser.Game;
  private scene: OfficeScene | null = null;
  private pending: OfficeState | null = null;
  private destroyed = false;
  private listeners: { [K in keyof Events]: Set<Events[K]> } = { agentClick: new Set() };

  constructor(parent: HTMLElement) {
    const scene = new OfficeScene((ready) => {
      if (this.destroyed) return;
      this.scene = ready;
      ready.events.on('agentClick', (id: string) => this.listeners.agentClick.forEach((cb) => cb(id)));
      if (this.pending) ready.setOfficeState(this.pending);
      this.pending = null;
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

  setState(agents: Agent[], settings: Settings, roles: Role[], floorKey = '*') {
    const state: OfficeState = { agents, settings, roles, floorKey };
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

  destroy() {
    this.destroyed = true;
    this.listeners.agentClick.clear();
    this.scene = null;
    this.game.destroy(true);
  }
}
