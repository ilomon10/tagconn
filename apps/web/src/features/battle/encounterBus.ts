// M14: a tiny typed bus between the NPC alert feed, the battle flow and the office scene (docs/design/battles.md 3.2).
// Same pattern as `game/sfxBus.ts`.
import type { EncounterChoice, EncounterOffer } from './types';

export interface EncounterBus {
  offer(o: EncounterOffer): void;
  onOffer(cb: (o: EncounterOffer) => void): () => void;
  shown(npcId: string): void;
  onShown(cb: (npcId: string) => void): () => void;
  choose(npcId: string, c: EncounterChoice): void;
  onChoice(cb: (npcId: string, c: EncounterChoice) => void): () => void;
  withdraw(npcId: string): void;
  onWithdraw(cb: (npcId: string) => void): () => void;
  /** Tests. */
  clear(): void;
}

function channel<A extends unknown[]>() {
  const subs = new Set<(...a: A) => void>();
  return {
    // A throwing listener never breaks the emitter or the other listeners.
    emit(...a: A): void {
      for (const cb of [...subs]) {
        try {
          cb(...a);
        } catch {
          /* isolated */
        }
      }
    },
    on(cb: (...a: A) => void): () => void {
      subs.add(cb);
      return () => void subs.delete(cb);
    },
    clear: () => subs.clear(),
  };
}

function createEncounterBus(): EncounterBus {
  const offer = channel<[EncounterOffer]>();
  const shown = channel<[string]>();
  const choice = channel<[string, EncounterChoice]>();
  const withdraw = channel<[string]>();
  return {
    offer: offer.emit, onOffer: offer.on,
    shown: shown.emit, onShown: shown.on,
    choose: choice.emit, onChoice: choice.on,
    withdraw: withdraw.emit, onWithdraw: withdraw.on,
    clear: () => {
      offer.clear();
      shown.clear();
      choice.clear();
      withdraw.clear();
    },
  };
}

export const encounterBus: EncounterBus = createEncounterBus();
