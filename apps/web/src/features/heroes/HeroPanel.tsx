import { useEffect, useMemo, useState } from 'react';
import { isHeroReleased, namePoolFor, pickHeroName, type Hero, type HeroNamePools, type HeroPatch } from '@tagconn/shared';
import { useOfficeStore } from '../../stores/officeStore';
import { useHeroStore } from '../../stores/heroStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useRoleLookup } from '../../lib/hooks';
import { updateSettings } from '../../lib/commands';
import { floorsInOrder, isMultiverseFloor, isTypingTarget } from '../../lib/floors';
import { getTheme } from '../../game/themes';
import { resolveTitle } from '../../game/lookResolver';
import { hexToNumber } from '../../game/textures';
import { useHeroPanelStore, type HeroPanelTab } from './store';
import { classifyHeroError, createHero, deleteHero, patchHero, resetHero } from './commands';
import { defaultHeroFloor, diffHeroPatch, draftFromHero, groupHeroesByRole, randomizeAppearance, type HeroDraft } from './formState';
import { rolesForNamePools, validateNamePools } from './namePools';
import { HeroList } from './HeroList';
import { HeroEditor } from './HeroEditor';
import { NamePoolEditor } from './NamePoolEditor';
import { Button, Select, cx } from '../../components/ui';

/**
 * The Heroes editor (docs/design/living-office.md section 3.4): a full-screen dialog reachable from
 * the TopBar "Heroes" button/`H` hotkey, `AgentDrawer`'s "Edit hero", and the Settings "Heroes"
 * section's "Edit name pools" link (`useHeroPanelStore`, see that file for why it's a plain store
 * rather than component state). Mounted once from `TopBar` (always present regardless of the active
 * tab) and gated on `open`.
 */
export function HeroPanel() {
  const open = useHeroPanelStore((s) => s.open);
  const storeProjectId = useHeroPanelStore((s) => s.projectId);
  const tab = useHeroPanelStore((s) => s.tab);
  const editingHeroId = useHeroPanelStore((s) => s.editingHeroId);
  const setTabRaw = useHeroPanelStore((s) => s.setTab);
  const setProjectIdRaw = useHeroPanelStore((s) => s.setProjectId);
  const setEditingHeroIdRaw = useHeroPanelStore((s) => s.setEditingHeroId);
  const closePanel = useHeroPanelStore((s) => s.close);

  const projects = useOfficeStore((s) => s.projects);
  const agents = useOfficeStore((s) => s.agents);
  const heroesMap = useHeroStore((s) => s.heroes);
  const settings = useSettingsStore((s) => s.settings);
  const roles = useSettingsStore((s) => s.roles);
  const roleLookup = useRoleLookup();

  const projectId = storeProjectId;
  const heroesForFloor = useMemo(() => Object.values(heroesMap).filter((h) => h.projectId === projectId), [heroesMap, projectId]);
  const editingHero: Hero | undefined = editingHeroId ? heroesMap[editingHeroId] : undefined;
  const theme = useMemo(() => getTheme(settings.office.style), [settings.office.style]);
  const groups = useMemo(() => groupHeroesByRole(heroesForFloor, theme, (r) => roleLookup(r).title), [heroesForFloor, theme, roleLookup]);
  const recruitRoles = useMemo(() => [...new Set(roles.filter((r) => r.enabled).map((r) => r.name))].sort(), [roles]);

  const [draft, setDraft] = useState<HeroDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [recruitRole, setRecruitRole] = useState('');
  const [recruitBusy, setRecruitBusy] = useState(false);
  const [recruitError, setRecruitError] = useState<string | null>(null);

  const [poolsBase, setPoolsBase] = useState<HeroNamePools>(settings.heroes.namePools);
  const [poolsDraft, setPoolsDraft] = useState<HeroNamePools>(settings.heroes.namePools);
  const [poolsBusy, setPoolsBusy] = useState(false);
  const [poolsMessage, setPoolsMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const dirty = !!(editingHero && draft && diffHeroPatch(editingHero, draft));
  const poolsDirty = JSON.stringify(poolsDraft) !== JSON.stringify(poolsBase);

  // Reset the edit-pane draft whenever the edited hero changes (a different hero, or none).
  useEffect(() => {
    setDraft(editingHero ? draftFromHero(editingHero) : null);
    setError(null);
    setConflict(null);
  }, [editingHeroId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Default the recruit role once roles are known.
  useEffect(() => {
    if (recruitRoles.length > 0 && !recruitRoles.includes(recruitRole)) setRecruitRole(recruitRoles[0]!);
  }, [recruitRoles, recruitRole]);

  // Adopt remote name-pool changes automatically unless there are unsaved local edits (same pattern as SettingsPanel).
  useEffect(() => {
    if (JSON.stringify(poolsDraft) === JSON.stringify(poolsBase) && settings.heroes.namePools !== poolsBase) {
      setPoolsBase(settings.heroes.namePools);
      setPoolsDraft(settings.heroes.namePools);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.heroes.namePools]);

  // Open on a sensible default floor the first time, if the caller didn't already pick one.
  useEffect(() => {
    if (open && storeProjectId === null) {
      const fallback = defaultHeroFloor(projects, useOfficeStore.getState().selectedProjectId, settings.office.floorOrder);
      if (fallback) setProjectIdRaw(fallback);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, storeProjectId]);

  if (!open) return null;

  const requestClose = () => {
    if ((dirty || poolsDirty) && !window.confirm('Discard unsaved changes?')) return;
    closePanel();
  };
  const changeFloor = (id: string) => {
    if (dirty && !window.confirm('Discard unsaved changes to this hero?')) return;
    setProjectIdRaw(id);
  };
  const selectHero = (id: string) => {
    if (dirty && !window.confirm('Discard unsaved changes to this hero?')) return;
    setEditingHeroIdRaw(id);
  };
  const changeTab = (t: HeroPanelTab) => {
    if (t === 'pools' && dirty && !window.confirm('Discard unsaved hero changes?')) return;
    if (t === 'roster' && tab === 'pools' && poolsDirty && !window.confirm('Discard unsaved name pool changes?')) return;
    setTabRaw(t);
  };

  const performSave = async () => {
    if (!editingHero || !draft || busy) return;
    const patch = diffHeroPatch(editingHero, draft);
    if (!patch) return;
    setBusy(true);
    setError(null);
    setConflict(null);
    try {
      const saved = await patchHero(editingHero.id, patch);
      setDraft(draftFromHero(saved));
    } catch (err) {
      const failure = classifyHeroError(err);
      if (failure.kind === 'conflict') setConflict(failure.message);
      else setError(failure.message);
    } finally {
      setBusy(false);
    }
  };

  /** Conflict dialog: "Reload" — discard my edits, take whatever's in the store now (already the
   *  latest, since a 409 implies someone else's save already arrived over the socket). */
  const performReload = () => {
    if (!editingHero) return;
    setDraft(draftFromHero(editingHero));
    setConflict(null);
    setError(null);
  };

  /** Conflict dialog: "Overwrite" — force my draft through with no `baseUpdatedAt` check. */
  const performOverwrite = async () => {
    if (!editingHero || !draft || busy) return;
    setBusy(true);
    setError(null);
    try {
      const patch: HeroPatch = { name: draft.name.trim(), title: draft.title.trim() === '' ? null : draft.title.trim(), appearance: draft.appearance };
      const saved = await patchHero(editingHero.id, patch);
      setDraft(draftFromHero(saved));
    } catch (err) {
      setError(classifyHeroError(err).message);
    } finally {
      setBusy(false);
      setConflict(null);
    }
  };

  const performReset = async () => {
    if (!editingHero || busy) return;
    if (!window.confirm(`Reset "${editingHero.name}" to its seeded name and appearance?`)) return;
    setBusy(true);
    setError(null);
    try {
      const reset = await resetHero(editingHero.id);
      setDraft(draftFromHero(reset));
    } catch (err) {
      setError(classifyHeroError(err).message);
    } finally {
      setBusy(false);
    }
  };

  const performDelete = async () => {
    if (!editingHero || busy || !isHeroReleased(editingHero)) return;
    if (!window.confirm(`Delete "${editingHero.name}"? This cannot be undone.`)) return;
    setBusy(true);
    setError(null);
    try {
      await deleteHero(editingHero.id);
      setEditingHeroIdRaw(null);
    } catch (err) {
      setError(classifyHeroError(err).message);
    } finally {
      setBusy(false);
    }
  };

  const performRandomize = (includeCostume: boolean) => {
    setDraft((d) => (d ? { ...d, appearance: randomizeAppearance(d.appearance, Date.now(), includeCostume) } : d));
  };

  const performRollName = () => {
    if (!editingHero || !draft) return;
    const taken = heroesForFloor.filter((h) => h.id !== editingHero.id).map((h) => h.name);
    const fallback = roleLookup(editingHero.role).title;
    const name = pickHeroName(namePoolFor(settings.heroes.namePools, editingHero.role), taken, Date.now(), fallback);
    setDraft({ ...draft, name });
  };

  const performRecruit = async () => {
    if (!projectId || !recruitRole || recruitBusy) return;
    setRecruitBusy(true);
    setRecruitError(null);
    try {
      const hero = await createHero({ projectId, role: recruitRole });
      setEditingHeroIdRaw(hero.id);
    } catch (err) {
      setRecruitError(classifyHeroError(err).message);
    } finally {
      setRecruitBusy(false);
    }
  };

  const performSavePools = async () => {
    const blocking = validateNamePools(poolsDraft).filter((i) => /At most|Too long/.test(i.message));
    if (blocking.length > 0) {
      setPoolsMessage({ tone: 'error', text: blocking.map((i) => `${i.role}: ${i.message}`).join(' ') });
      return;
    }
    setPoolsBusy(true);
    setPoolsMessage(null);
    try {
      const next = await updateSettings({ heroes: { namePools: poolsDraft } });
      setPoolsBase(next.heroes.namePools);
      setPoolsDraft(next.heroes.namePools);
      setPoolsMessage({ tone: 'ok', text: 'Name pools saved.' });
    } catch (err) {
      setPoolsMessage({ tone: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setPoolsBusy(false);
    }
  };

  // Global shortcuts while the panel is open, capture phase (same convention as the Hall Planner —
  // `data-modal="heroes"` below is what makes floor hotkeys pause, `lib/floors.ts` `isModalOpen`).
  const onKeyDownCapture = (e: React.KeyboardEvent) => {
    const isSave = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's';
    if (isSave) {
      e.preventDefault();
      e.stopPropagation();
      if (tab === 'roster') void performSave();
      else void performSavePools();
      return;
    }
    if (e.key === 'Escape' && !isTypingTarget(e.target as EventTarget)) {
      e.stopPropagation();
      requestClose();
    }
  };

  // The Multiverse isn't a real project — heroes are always edited for one concrete floor, so it's
  // excluded from this picker even though `floorsInOrder` always appends it (docs/design/living-office.md section 6.3).
  const floorList = floorsInOrder(Object.values(projects), settings.office.floorOrder, projectId ?? undefined).filter((p) => !isMultiverseFloor(p.id));

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-ink-950" data-modal="heroes" role="dialog" aria-modal="true" aria-label="Heroes" onKeyDownCapture={onKeyDownCapture}>
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-ink-700 bg-ink-900 px-3">
        <span className="font-pixel text-xs font-semibold text-ink-100">Heroes</span>
        <Select aria-label="Floor" className="w-56" value={projectId ?? ''} onChange={(e) => changeFloor(e.target.value)} disabled={floorList.length === 0}>
          {floorList.length === 0 && <option value="">(no floors)</option>}
          {floorList.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.archived ? ' (archived)' : ''}
            </option>
          ))}
        </Select>
        <nav className="ml-2 flex items-center gap-0.5 rounded-lg bg-ink-850 p-0.5">
          <button type="button" onClick={() => changeTab('roster')} className={cx('rounded-md px-3 py-1 text-xs', tab === 'roster' ? 'bg-ink-600 text-ink-100' : 'text-ink-400 hover:text-ink-100')}>
            Roster
          </button>
          <button type="button" onClick={() => changeTab('pools')} className={cx('rounded-md px-3 py-1 text-xs', tab === 'pools' ? 'bg-ink-600 text-ink-100' : 'text-ink-400 hover:text-ink-100')}>
            Name pools
          </button>
        </nav>
        <div className="ml-auto flex items-center gap-2">
          {tab === 'pools' && poolsMessage && <span className={cx('max-w-xs truncate text-[11px]', poolsMessage.tone === 'ok' ? 'text-emerald-300' : 'text-red-300')}>{poolsMessage.text}</span>}
          {tab === 'pools' && (
            <>
              <Button
                disabled={!poolsDirty || poolsBusy}
                onClick={() => {
                  setPoolsDraft(poolsBase);
                  setPoolsMessage(null);
                }}
              >
                Revert
              </Button>
              <Button variant="primary" disabled={!poolsDirty || poolsBusy} onClick={() => void performSavePools()} title="Ctrl/Cmd+S">
                Save
              </Button>
            </>
          )}
          <Button variant="ghost" onClick={requestClose} aria-label="Close">
            ✕
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1">
        {tab === 'roster' ? (
          !projectId ? (
            <div className="grid h-full place-items-center text-xs text-ink-400">No floors yet — heroes need a floor to belong to.</div>
          ) : (
            <div className="flex h-full">
              <HeroList
                groups={groups}
                agents={agents}
                selectedId={editingHeroId}
                onSelect={selectHero}
                roleColor={(r) => roleLookup(r).color}
                recruitRoles={recruitRoles}
                recruitRole={recruitRole}
                onRecruitRoleChange={setRecruitRole}
                onRecruit={() => void performRecruit()}
                recruitBusy={recruitBusy}
                recruitError={recruitError}
              />
              {editingHero && draft ? (
                <HeroEditor
                  hero={editingHero}
                  draft={draft}
                  onDraftChange={setDraft}
                  themedTitle={resolveTitle(theme, editingHero.role, roleLookup(editingHero.role).title)}
                  roleColorHex={roleLookup(editingHero.role).color}
                  roleColorNumber={hexToNumber(roleLookup(editingHero.role).color)}
                  dirty={dirty}
                  busy={busy}
                  error={error}
                  onSave={() => void performSave()}
                  onReset={() => void performReset()}
                  onDelete={() => void performDelete()}
                  onRandomize={performRandomize}
                  onRollName={performRollName}
                  canDelete={isHeroReleased(editingHero)}
                />
              ) : (
                <div className="flex flex-1 items-center justify-center text-xs text-ink-400">Select a hero to edit, or recruit one.</div>
              )}
            </div>
          )
        ) : (
          <NamePoolEditor
            pools={poolsDraft}
            roles={rolesForNamePools(
              roles.map((r) => r.name),
              poolsDraft,
            )}
            onChange={setPoolsDraft}
          />
        )}
      </div>

      {conflict && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4" role="alertdialog" aria-modal="true">
          <div className="w-full max-w-sm rounded-lg border border-ink-600 bg-ink-850 p-4">
            <h2 className="mb-2 text-sm font-semibold text-ink-100">Hero changed elsewhere</h2>
            <p className="mb-4 text-[12px] text-ink-300">{conflict}</p>
            <div className="flex justify-end gap-2">
              <Button variant="subtle" disabled={busy} onClick={performReload}>
                Reload (discard mine)
              </Button>
              <Button variant="primary" disabled={busy} onClick={() => void performOverwrite()}>
                Overwrite
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
