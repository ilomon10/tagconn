import { useEffect, useRef } from 'react';
import { useOfficeStore } from '../stores/officeStore';
import { useSettingsStore } from '../stores/settingsStore';
import { resolveScreenFx, useDisplayPrefsStore } from '../stores/displayPrefsStore';
import { isModalOpen, isTypingTarget, onlyModalIs } from '../lib/floors';
import { useRequireAdmin } from '../features/auth/useRequireAdmin';
import { defaultHeroFloor } from '../features/heroes/formState';
import { useHeroPanelStore } from '../features/heroes/store';
import { useReceptionistUiStore } from '../features/receptionist/uiStore';
import { menuActionForKey, type MenuActionId } from './menuHotkeys';
import { useOverlayStore } from './overlays';

/** The office's monitor screen effect (M9, docs/decisions.md #25): a per-browser display preference over the server default. */
export function useScreenEffect() {
  const shadersEnabled = useSettingsStore((s) => s.settings.office.shaders.enabled);
  const serverScreen = useSettingsStore((s) => s.settings.office.shaders.screen);
  const screenOn = useDisplayPrefsStore((s) => s.screenOn);
  const screenEffect = useDisplayPrefsStore((s) => s.screenEffect);
  const setScreenOn = useDisplayPrefsStore((s) => s.setScreenOn);
  const setScreenEffect = useDisplayPrefsStore((s) => s.setScreenEffect);
  const reset = useDisplayPrefsStore((s) => s.reset);
  const resolved = resolveScreenFx(serverScreen, { screenOn, screenEffect });
  return { disabled: !shadersEnabled, on: resolved.on, effect: resolved.effect, toggle: () => setScreenOn(!resolved.on), setEffect: setScreenEffect, reset };
}

export type PanelActionId = 'board' | 'log' | 'quests' | 'roles' | 'settings' | 'heroes' | 'receptionist';

/**
 * The panel-opening actions, shared by the menu and the in-office furniture triggers (M12 G3).
 * Heroes opens on the current floor (or the first floor in stairs order for the Multiverse);
 * the Receptionist goes through the same admin guard it always did.
 */
export function usePanelActions(): Record<PanelActionId, { run: () => void; disabled: boolean }> {
  const projects = useOfficeStore((s) => s.projects);
  const selected = useOfficeStore((s) => s.selectedProjectId);
  const floorOrder = useSettingsStore((s) => s.settings.office.floorOrder);
  const openHeroes = useHeroPanelStore((s) => s.openHeroes);
  const openReceptionist = useReceptionistUiStore((s) => s.openPanel);
  const openOverlay = useOverlayStore((s) => s.openOverlay);
  const { guard } = useRequireAdmin();
  const heroFloor = defaultHeroFloor(projects, selected, floorOrder);

  return {
    board: { run: () => openOverlay('board'), disabled: false },
    log: { run: () => openOverlay('log'), disabled: false },
    quests: { run: () => openOverlay('quests'), disabled: false },
    roles: { run: () => openOverlay('roles'), disabled: false },
    settings: { run: () => openOverlay('settings'), disabled: false },
    heroes: { run: () => heroFloor && openHeroes(heroFloor), disabled: !heroFloor },
    receptionist: { run: () => guard(() => openReceptionist()), disabled: false },
  };
}

/**
 * Everything the top bar's menu can do, as one `run` per action id. The menu rows and the global
 * hotkey listener below both go through this, so a key press and a tap always do the same thing.
 */
export function useMenuActions({ onOpenPlanner, onManageFloors, onToggleMenu }: { onOpenPlanner: () => void; onManageFloors: () => void; onToggleMenu: () => void }) {
  const panels = usePanelActions();
  const screen = useScreenEffect();

  const actions: Record<MenuActionId, { run: () => void; disabled: boolean }> = {
    ...panels,
    menu: { run: onToggleMenu, disabled: false },
    planner: { run: onOpenPlanner, disabled: false },
    screen: { run: screen.toggle, disabled: screen.disabled },
    floors: { run: onManageFloors, disabled: false },
  };

  // The listener is registered once; it reads the latest actions through a ref.
  const ref = useRef(actions);
  ref.current = actions;
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const id = menuActionForKey(e);
      if (!id || isTypingTarget(e.target)) return;
      // `M` also closes the menu; every other key waits for whatever modal is open.
      if (isModalOpen() && !(id === 'menu' && onlyModalIs('menu'))) return;
      const a = ref.current[id];
      if (a.disabled) return;
      e.preventDefault();
      a.run();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return actions;
}
