import { useEffect, useRef } from 'react';
import { usePanelActions } from '../../app/useMenuActions';
import type { OfficeGame } from '../../game/OfficeGame';
import type { FurnitureAction } from '../../game/procgen/types';
import { isModalOpen } from '../../lib/floors';
import { useReceptionistUiStore } from '../receptionist/uiStore';

type PanelRun = { run: () => void; disabled: boolean };

/**
 * Pure routing of a furniture click (M12 G3): ignored while a modal is open; the receptionist opens its
 * panel directly (the in-world rule, like `receptionistClick`: the panel gates itself); every other action
 * runs the same panel action as the menu unless it is disabled.
 */
export function routeFurnitureClick(
  action: FurnitureAction,
  deps: { modalOpen: boolean; panels: Record<Exclude<FurnitureAction, 'receptionist'>, PanelRun>; openReceptionist: () => void },
): boolean {
  if (deps.modalOpen) return false;
  if (action === 'receptionist') {
    deps.openReceptionist();
    return true;
  }
  const panel = deps.panels[action];
  if (!panel || panel.disabled) return false;
  panel.run();
  return true;
}

/** Opens the panel for a clicked trigger furniture item. The canvas adds no focus stops: every trigger duplicates a menu entry and hotkey. */
export function useFurnitureTriggers(game: OfficeGame | null): void {
  const panels = usePanelActions();
  const ref = useRef(panels);
  ref.current = panels;
  useEffect(() => {
    if (!game) return;
    return game.on('furnitureClick', (action) =>
      routeFurnitureClick(action, { modalOpen: isModalOpen(), panels: ref.current, openReceptionist: () => useReceptionistUiStore.getState().openPanel() }),
    );
  }, [game]);
}
