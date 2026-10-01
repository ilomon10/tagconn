import { useEffect, useRef } from 'react';
import { isKnockedOut, type Hero, type HeroProgress } from '@tagconn/shared';
import { usePanelActions } from '../../app/useMenuActions';
import type { OfficeGame } from '../../game/OfficeGame';
import type { FurnitureAction } from '../../game/procgen/types';
import { sfxBus } from '../../game/sfxBus';
import { isModalOpen } from '../../lib/floors';
import { useHeroStore } from '../../stores/heroStore';
import { useOfficeStore, ALL_FLOORS } from '../../stores/officeStore';
import { getProgress, useProgressStore } from '../../stores/progressStore';
import { useRequireAdmin } from '../auth/useRequireAdmin';
import { healHero } from '../battle/commands';

type PanelRun = { run: () => void; disabled: boolean };
type PanelAction = Exclude<FurnitureAction, 'infirmary'>;

/** Ids of the KO'd heroes on `floor` (every floor for ALL_FLOORS), in hero-map order. */
export function koHeroIds(heroes: Record<string, Hero>, progress: Record<string, HeroProgress>, floor: string, now: number): string[] {
  return Object.values(heroes)
    .filter((h) => (floor === ALL_FLOORS || h.projectId === floor) && isKnockedOut(getProgress(progress, h.id), now))
    .map((h) => h.id);
}

/**
 * M14 T1 coffee break: heals every KO'd hero of the selected floor early. Ignored while a modal is open or without write
 * access. Returns the number of heal requests sent (the cue plays once, only when there was someone to heal).
 */
export function runCoffeeBreak(deps: {
  modalOpen: boolean;
  allowed: boolean;
  heroIds: readonly string[];
  heal: (heroId: string) => Promise<unknown>;
  cue: () => void;
}): number {
  if (deps.modalOpen || !deps.allowed || deps.heroIds.length === 0) return 0;
  for (const id of deps.heroIds) deps.heal(id).catch(() => undefined); // a hero healed meanwhile (409) is fine
  deps.cue();
  return deps.heroIds.length;
}

/**
 * Pure routing of a furniture click (M12 G3): ignored while a modal is open; every action, the receptionist
 * included, runs the same panel action as the menu (so the admin guard applies) unless it is disabled.
 */
export function routeFurnitureClick(action: PanelAction, deps: { modalOpen: boolean; panels: Record<PanelAction, PanelRun> }): boolean {
  if (deps.modalOpen) return false;
  const panel = deps.panels[action];
  if (!panel || panel.disabled) return false;
  panel.run();
  return true;
}

/** Opens the panel for a clicked trigger furniture item. The canvas adds no focus stops: every trigger duplicates a menu entry and hotkey. */
export function useFurnitureTriggers(game: OfficeGame | null): void {
  const panels = usePanelActions();
  const { allowed } = useRequireAdmin();
  const ref = useRef(panels);
  ref.current = panels;
  const allowedRef = useRef(allowed);
  allowedRef.current = allowed;
  useEffect(() => {
    if (!game) return;
    return game.on('furnitureClick', (action) => {
      if (action === 'infirmary') {
        runCoffeeBreak({
          modalOpen: isModalOpen(),
          allowed: allowedRef.current,
          heroIds: koHeroIds(useHeroStore.getState().heroes, useProgressStore.getState().progress, useOfficeStore.getState().selectedProjectId, Date.now()),
          heal: healHero,
          cue: () => sfxBus.emit({ id: 'battle-heal' }),
        });
        return;
      }
      routeFurnitureClick(action, { modalOpen: isModalOpen(), panels: ref.current });
    });
  }, [game]);
}
