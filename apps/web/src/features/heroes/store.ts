import { create } from 'zustand';
import type { Hero } from '@tagconn/shared';

/**
 * Whether the Heroes editor is open, and where. This is a plain zustand store (not React state owned
 * by one component) because the panel is reachable from three different subtrees that don't share a
 * parent below `App`: the TopBar button/hotkey, "Edit hero" in `AgentDrawer` (inside `OfficeView`),
 * and the "Name pools" link in `SettingsPanel`. `TopBar` (always mounted regardless of the active tab,
 * see `app/App.tsx`) renders `<HeroPanel />` gated on `open`; the other two just call `openHeroes`/
 * `openHeroEditor` below.
 */

export type HeroPanelTab = 'roster' | 'pools';

export interface HeroPanelState {
  open: boolean;
  /** The floor being managed. Never the Multiverse ("*") — heroes are always edited for one floor. */
  projectId: string | null;
  tab: HeroPanelTab;
  /** Hero currently shown in the edit pane, if any. */
  editingHeroId: string | null;
  /** Opens on `projectId` (defaults to the current one already shown, if any). */
  openHeroes(projectId: string, tab?: HeroPanelTab): void;
  /** Opens directly on one hero's edit pane (AgentDrawer's "Edit hero"). */
  openHeroEditor(hero: Hero): void;
  setTab(tab: HeroPanelTab): void;
  setProjectId(projectId: string): void;
  setEditingHeroId(id: string | null): void;
  close(): void;
}

export const useHeroPanelStore = create<HeroPanelState>()((set) => ({
  open: false,
  projectId: null,
  tab: 'roster',
  editingHeroId: null,
  openHeroes: (projectId, tab = 'roster') => set({ open: true, projectId, tab }),
  openHeroEditor: (hero) => set({ open: true, projectId: hero.projectId, tab: 'roster', editingHeroId: hero.id }),
  setTab: (tab) => set({ tab }),
  setProjectId: (projectId) => set({ projectId, editingHeroId: null }),
  setEditingHeroId: (editingHeroId) => set({ editingHeroId }),
  close: () => set({ open: false, editingHeroId: null }),
}));
