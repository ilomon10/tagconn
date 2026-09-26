import { useEffect, useMemo, useRef, useState } from 'react';
import { validateLayout, type DoorSpec, type OfficeStyle } from '@tagconn/shared';
import { generateMap, generateRandomLayout, type GeneratedMap } from '../../game/procgen';
import { getTheme } from '../../game/themes';
import { ALL_FLOORS, useOfficeStore } from '../../stores/officeStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useLayoutStore, layoutForProject } from '../../stores/layoutStore';
import { draftAsLayout, useEditorStore, type EditorTool } from '../../stores/editorStore';
import { assignLayout, classifySaveLayoutError, deleteLayout, refreshLayouts, saveLayout } from '../../lib/layoutCommands';
import { resolveShortcut, type KeyLike } from './shortcuts';
import { autoDoorsForRoom } from './reachability';
import { canSaveLayout, sealedRoomWarnings } from './saveGate';
import { PlanCanvas } from './PlanCanvas';
import { Inspector } from './Inspector';
import { IssueList } from './IssueList';
import { PreviewGame } from './PreviewScene';
import { Button, Select } from '../../components/ui';

const TOOLS: { tool: EditorTool; label: string; hotkey: string }[] = [
  { tool: 'select', label: 'Select', hotkey: 'V' },
  { tool: 'room', label: 'Room', hotkey: 'R' },
  { tool: 'stairs', label: 'Stairs', hotkey: 'S' },
  { tool: 'doors', label: 'Doors', hotkey: 'D' },
  { tool: 'hand', label: 'Hand', hotkey: 'H / Space' },
];

const HELP_LINES = [
  ['V / R / S / D / H', 'Select / Room / Stairs / Doors / Hand tool'],
  ['Drag (Room/Stairs)', 'Draw a room; release to pick its type'],
  ['1-9, 0', 'Pick a room type from the popover'],
  ['Click / Shift+click', 'Select / add to selection'],
  ['Drag body', 'Move the selection'],
  ['Drag a handle', 'Resize the selected room'],
  ['Arrows / Shift+Arrows', 'Nudge selection by 1 / 5 tiles'],
  ['Alt+Arrows', 'Resize the selected room by 1 tile'],
  ['Delete / Backspace', 'Delete the selection'],
  ['Ctrl/Cmd+D', 'Duplicate the selected rooms'],
  ['Doors tool: click a wall', 'Add a door (Shift+click for width 2)'],
  ['Doors tool: drag a door', 'Move it along its wall'],
  ['Doors tool: drag its end handle', 'Resize it (width 1-3)'],
  ['Doors tool: select + Delete', 'Remove a door'],
  ['Doors tool: select + Arrows', 'Nudge a door along its wall'],
  ['Ctrl/Cmd+Z', 'Undo'],
  ['Ctrl/Cmd+Shift+Z or Ctrl+Y', 'Redo'],
  ['Ctrl/Cmd+G', 'Surprise me (random layout)'],
  ['P', 'Toggle the styled preview'],
  ['Ctrl/Cmd+S', 'Save (blocked while errors exist)'],
  ['Esc', 'Cancel the popover, then clear the door/room selection, then close'],
];

/**
 * `targetProjectId`: opens the planner preloaded for a specific floor regardless of the globally
 * selected one — used by the "Edit floor" row action in Manage floors (FloorManager), which lists
 * every floor, not just the selected one. The floating "Hall Planner" button omits it and gets the
 * old behavior (whatever floor is currently selected).
 */
export function OfficeEditor({ onClose, targetProjectId }: { onClose: () => void; targetProjectId?: string }) {
  const store = useEditorStore();
  const { draft, selection, selectedDoor, tool, history, future, dirty, builtin, originalId, originalUpdatedAt } = store;
  const layouts = useLayoutStore((s) => s.layouts);
  const settings = useSettingsStore((s) => s.settings);
  const selectedProjectId = useOfficeStore((s) => s.selectedProjectId);
  const projects = useOfficeStore((s) => s.projects);
  const effectiveProjectId = targetProjectId ?? selectedProjectId;
  const project = effectiveProjectId === ALL_FLOORS ? undefined : projects[effectiveProjectId];

  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewStyle, setPreviewStyle] = useState<OfficeStyle>(settings.office.style);
  const [helpOpen, setHelpOpen] = useState(false);
  const [flashRoomIds, setFlashRoomIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set on a 409 conflict (someone else saved or deleted this layout since it was loaded): offers
  // Reload (discard mine) or Save as copy instead of silently losing one side's edits.
  const [conflict, setConflict] = useState<string | null>(null);
  const [generatedMap, setGeneratedMap] = useState<GeneratedMap | null>(null);

  const previewHostRef = useRef<HTMLDivElement>(null);
  const previewGameRef = useRef<PreviewGame | null>(null);
  const openedRef = useRef(false);

  const theme = useMemo(() => getTheme(draft?.style ?? settings.office.style), [draft?.style, settings.office.style]);
  const layoutList = useMemo(
    () => Object.values(layouts).sort((a, b) => (a.builtin === b.builtin ? a.name.localeCompare(b.name) : a.builtin ? -1 : 1)),
    [layouts],
  );
  const selectedRoom = draft?.rooms.find((r) => r.id === selection[0]);
  // The generator's issues already include validateLayout's (guild-hall.md section 4); fall back to
  // the geometry-only check for the instant after an edit, before the 120ms debounce recomputes the map.
  const issues = generatedMap?.issues ?? (draft ? validateLayout(draft) : []);
  const canSave = !!draft && canSaveLayout(issues, builtin);

  // ---------------------------------------------------------------------------------------- open
  useEffect(() => {
    if (openedRef.current) return;
    openedRef.current = true;
    void refreshLayouts().then((list) => {
      const registry = Object.fromEntries(list.map((l) => [l.id, l]));
      const initial = layoutForProject(registry, project, settings.office.defaultLayoutId);
      useEditorStore.getState().load(initial);
      // "Edit floor" (FloorManager) always wants something editable, not a read-only builtin —
      // "duplicate-to-edit" up front instead of making the user click Duplicate first.
      if (targetProjectId && initial.builtin) useEditorStore.getState().duplicateAsEditable();
    });
    return () => useEditorStore.getState().close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ------------------------------------------------------------------------- debounced regenerate
  useEffect(() => {
    if (!draft) {
      setGeneratedMap(null);
      return;
    }
    const t = setTimeout(() => {
      try {
        setGeneratedMap(generateMap(draftAsLayout(draft)));
      } catch {
        setGeneratedMap(null);
      }
      if (previewOpen && previewGameRef.current) previewGameRef.current.update(draft, previewStyle);
    }, 120);
    return () => clearTimeout(t);
  }, [draft, previewOpen, previewStyle]);

  // --------------------------------------------------------------------------------- preview pane
  useEffect(() => {
    if (!previewOpen || !previewHostRef.current || !draft) return;
    const game = new PreviewGame(previewHostRef.current, draft, previewStyle);
    previewGameRef.current = game;
    return () => {
      game.destroy();
      previewGameRef.current = null;
    };
    // Recreated only when the pane opens/closes; draft/style updates go through the debounced .update() above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewOpen]);

  // ------------------------------------------------------------------------------------- actions
  const requestClose = () => {
    if (dirty && !window.confirm('Discard unsaved changes to this layout?')) return;
    onClose();
  };

  const performSave = async () => {
    if (!draft || !canSave || busy) return;
    // "room-sealed" is a warning, not an error — saving is allowed, but only with an explicit
    // confirmation (guild-hall.md section 5: sealing a room is a deliberate, if unusual, choice).
    const sealed = sealedRoomWarnings(issues);
    if (sealed.length && !window.confirm(`${sealed.length} room(s) are sealed and unreachable. Save anyway?`)) return;
    setBusy(true);
    setError(null);
    setConflict(null);
    try {
      // baseUpdatedAt only makes sense when replacing a layout we actually loaded from the server;
      // omitting it on a create (no originalId) keeps that path's old, unconditional behavior.
      const input = originalId ? { ...draft, id: originalId, baseUpdatedAt: originalUpdatedAt } : draft;
      const saved = await saveLayout(input);
      useEditorStore.getState().applySaved(saved);
    } catch (err) {
      const failure = classifySaveLayoutError(err);
      if (failure.kind === 'conflict') setConflict('This layout was changed or deleted elsewhere.');
      else setError(failure.message);
    } finally {
      setBusy(false);
    }
  };

  /** Conflict dialog: "Reload" — discard my edits and load whatever is on the server now. */
  const performReload = async () => {
    if (!originalId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const list = await refreshLayouts();
      const fresh = list.find((l) => l.id === originalId);
      if (fresh) {
        store.load(fresh);
      } else {
        setError(`"${draft?.name ?? originalId}" was deleted elsewhere — start a new layout or pick another.`);
        store.createNew();
      }
    } finally {
      setBusy(false);
      setConflict(null);
    }
  };

  /** Conflict dialog: "Save as copy" — keep my edits, but as a brand-new layout (no baseUpdatedAt). */
  const performSaveAsCopy = async () => {
    if (busy) return;
    store.duplicateAsEditable();
    setConflict(null);
    setError(null);
    setBusy(true);
    try {
      const fresh = useEditorStore.getState().draft;
      if (!fresh) return;
      const saved = await saveLayout(fresh);
      useEditorStore.getState().applySaved(saved);
    } catch (err) {
      setError(classifySaveLayoutError(err).message);
    } finally {
      setBusy(false);
    }
  };

  const performSurpriseMe = () => {
    if (!draft || builtin) return;
    const seed = Math.floor(Math.random() * 0xffffffff);
    const result = generateRandomLayout({ width: draft.width, height: draft.height, seed, background: draft.background ?? 'hall' });
    store.replaceDraft({ ...result, id: draft.id, name: draft.name });
  };

  const performDelete = async () => {
    if (!originalId || builtin) return;
    if (!window.confirm(`Delete "${draft?.name}"? Floors using it fall back to the default layout.`)) return;
    setBusy(true);
    setError(null);
    try {
      await deleteLayout(originalId);
      store.close();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const performAssign = async (layoutId: string | null) => {
    if (!project) return;
    setBusy(true);
    setError(null);
    try {
      await assignLayout(project.id, layoutId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const openLayout = (id: string) => {
    if (dirty && !window.confirm('Discard unsaved changes to the current layout?')) return;
    const l = layouts[id];
    if (l) store.load(l);
  };

  const flash = (roomIds: string[]) => {
    if (!roomIds.length) return;
    store.select(roomIds);
    setFlashRoomIds(roomIds);
    setTimeout(() => setFlashRoomIds((cur) => (cur === roomIds ? [] : cur)), 1200);
  };

  /** IssueList's one-click "Fix: add door on <side>" (guild-hall.md section 5). */
  const performFix = (roomId: string, suggestion: DoorSpec) => {
    if (!generatedMap) return;
    const room = draft?.rooms.find((r) => r.id === roomId);
    if (!room) return;
    store.addDoor(roomId, suggestion, autoDoorsForRoom(generatedMap, room));
    flash([roomId]);
  };

  // ------------------------------------------------------------------------------ global shortcuts
  // Capture phase + stopPropagation: the planner's own shortcuts must win over any other
  // window-level keydown listener (e.g. the office's floor-switch hotkeys), which is also why the
  // root element below carries `data-modal="hall-planner"` for listeners that check for it directly.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const action = resolveShortcut(e as unknown as KeyLike);
      if (!action) return;
      e.stopPropagation();
      switch (action.type) {
        case 'undo':
          e.preventDefault();
          store.undo();
          break;
        case 'redo':
          e.preventDefault();
          store.redo();
          break;
        case 'delete':
          if (selectedDoor) {
            e.preventDefault();
            store.removeDoor(selectedDoor.roomId, selectedDoor.index);
          } else if (selection.length) {
            e.preventDefault();
            store.removeRooms(selection);
          }
          break;
        case 'escape':
          if (selectedDoor) store.clearDoorSelection();
          else if (selection.length) store.clearSelection();
          else requestClose();
          break;
        case 'duplicate':
          if (selection.length) {
            e.preventDefault();
            store.duplicateRooms(selection);
          }
          break;
        case 'save':
          e.preventDefault();
          void performSave();
          break;
        case 'surprise':
          e.preventDefault();
          performSurpriseMe();
          break;
        case 'preview-toggle':
          setPreviewOpen((v) => !v);
          break;
        case 'help':
          setHelpOpen((v) => !v);
          break;
        case 'tool':
          store.setTool(action.tool);
          if (action.tool === 'stairs') store.setPendingRoomType('stairs');
          break;
        case 'nudge':
          if (selectedDoor) {
            e.preventDefault();
            const room = draft?.rooms.find((r) => r.id === selectedDoor.roomId);
            const door = room?.doors?.[selectedDoor.index];
            if (door) {
              // A door only ever moves along its own wall: n/s doors slide in x, e/w doors slide in y.
              const delta = door.side === 'n' || door.side === 's' ? action.dx : action.dy;
              if (delta) store.nudgeDoor(selectedDoor.roomId, selectedDoor.index, delta);
            }
          } else if (selection.length === 1 && action.resize) {
            const r = draft?.rooms.find((x) => x.id === selection[0]);
            if (r) store.updateRoom(r.id, { w: Math.max(1, r.w + action.dx), h: Math.max(1, r.h + action.dy) });
          } else if (selection.length) {
            store.nudgeSelection(action.dx, action.dy);
          }
          break;
      }
    };
    window.addEventListener('keydown', onKeyDown, true); // capture: see comment above
    return () => window.removeEventListener('keydown', onKeyDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, selectedDoor, draft, dirty]);

  if (!draft) {
    return (
      <div
        className="fixed inset-0 z-50 grid place-items-center bg-black/70 text-ink-300"
        data-modal="hall-planner"
        role="dialog"
        aria-modal="true"
        aria-label="Hall Planner"
      >
        Loading the Hall Planner…
      </div>
    );
  }

  const errorCount = issues.filter((i) => i.severity === 'error').length;

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-ink-950"
      data-modal="hall-planner"
      role="dialog"
      aria-modal="true"
      aria-label="Hall Planner"
    >
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-ink-700 bg-ink-900 px-3">
        <span className="font-pixel text-xs font-semibold text-ink-100">Hall Planner</span>
        <Select className="w-48" value={originalId ?? ''} onChange={(e) => (e.target.value ? openLayout(e.target.value) : store.createNew())}>
          <option value="">(unsaved) {draft.name}</option>
          {layoutList.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
              {l.builtin ? ' (builtin)' : ''}
            </option>
          ))}
        </Select>
        <Button onClick={() => store.createNew({ name: 'New Floor' })}>New</Button>
        <Button onClick={() => store.duplicateAsEditable()}>Duplicate</Button>
        <Button variant="danger" disabled={!originalId || builtin || busy} onClick={performDelete}>
          Delete
        </Button>
        <div className="mx-1 h-6 w-px bg-ink-700" />
        <Button disabled={history.length === 0} onClick={() => store.undo()} title="Ctrl/Cmd+Z">
          Undo
        </Button>
        <Button disabled={future.length === 0} onClick={() => store.redo()} title="Ctrl/Cmd+Shift+Z">
          Redo
        </Button>
        <Button disabled={builtin} onClick={performSurpriseMe} title="Ctrl/Cmd+G">
          🎲 Surprise me
        </Button>
        <Button variant={previewOpen ? 'primary' : 'subtle'} onClick={() => setPreviewOpen((v) => !v)} title="P">
          Preview
        </Button>
        {previewOpen && (
          <Select className="w-28" value={previewStyle} onChange={(e) => setPreviewStyle(e.target.value as OfficeStyle)}>
            <option value="modern">Modern</option>
            <option value="guild">Guild</option>
          </Select>
        )}
        <div className="ml-auto flex items-center gap-2">
          {error && <span className="max-w-xs truncate text-[11px] text-red-300">{error}</span>}
          {project && (
            <>
              <Button disabled={!originalId || busy} onClick={() => void performAssign(originalId ?? null)} title="Assigns this saved layout to the current floor">
                Use on {project.name}
              </Button>
              {project.layoutId && (
                <Button variant="ghost" disabled={busy} onClick={() => void performAssign(null)}>
                  Reset floor
                </Button>
              )}
            </>
          )}
          <Button
            variant="primary"
            disabled={!canSave || busy}
            onClick={() => void performSave()}
            title={builtin ? 'Builtin layouts are read-only — Duplicate to edit' : errorCount ? `${errorCount} error(s) to fix first` : 'Ctrl/Cmd+S'}
          >
            Save
          </Button>
          <Button variant="ghost" onClick={() => setHelpOpen(true)} title="?">
            ?
          </Button>
          <Button variant="ghost" onClick={requestClose} aria-label="Close">
            ✕
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <nav className="flex w-14 shrink-0 flex-col items-center gap-1 border-r border-ink-700 bg-ink-900 py-2">
          {TOOLS.map((t) => (
            <button
              key={t.tool}
              type="button"
              title={`${t.label} (${t.hotkey})`}
              onClick={() => store.setTool(t.tool)}
              className={
                'flex w-11 flex-col items-center rounded-md py-1.5 text-[10px] ' +
                (tool === t.tool ? 'bg-cozy text-ink-950' : 'text-ink-300 hover:bg-ink-800')
              }
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <PlanCanvas generatedMap={generatedMap} issues={issues} theme={theme} flashRoomIds={flashRoomIds} />
          <div className="h-32 shrink-0 overflow-hidden border-t border-ink-700 bg-ink-900">
            <IssueList issues={issues} rooms={draft.rooms} reachability={generatedMap?.reachability} onSelectIssue={flash} onFix={performFix} />
          </div>
        </div>

        {previewOpen && (
          <div className="w-80 shrink-0 border-l border-ink-700 bg-black">
            <div ref={previewHostRef} className="h-full w-full" />
          </div>
        )}

        <Inspector
          draft={draft}
          theme={theme}
          selectedRoom={selectedRoom}
          onMeta={(patch) => store.setMeta(patch)}
          onFurnishDefaults={(patch) => store.setFurnishDefaults(patch)}
          onRoomChange={(id, patch) => store.updateRoom(id, patch)}
          onRoomFurnish={(id, patch) => store.setRoomFurnish(id, patch)}
          onRerollFurnish={(id) => store.rerollRoomSeed(id)}
          onResetFurnish={(id) => store.resetRoomFurnish(id)}
          onAutoDoors={(id) => store.setRoomDoors(id, undefined)}
          onSealRoom={(id) => store.sealRoom(id)}
        />
      </div>

      {helpOpen && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4" onClick={() => setHelpOpen(false)}>
          <div className="max-h-[80vh] w-full max-w-md overflow-y-auto rounded-lg border border-ink-600 bg-ink-850 p-4" onClick={(e) => e.stopPropagation()}>
            <h2 className="mb-2 text-sm font-semibold text-ink-100">Hall Planner shortcuts</h2>
            <table className="w-full text-[11px] text-ink-300">
              <tbody>
                {HELP_LINES.map(([keys, desc]) => (
                  <tr key={keys} className="border-t border-ink-800">
                    <td className="whitespace-nowrap py-1 pr-3 font-mono text-ink-100">{keys}</td>
                    <td className="py-1">{desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Button className="mt-3" onClick={() => setHelpOpen(false)}>
              Close
            </Button>
          </div>
        </div>
      )}

      {conflict && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4" role="alertdialog" aria-modal="true">
          <div className="w-full max-w-sm rounded-lg border border-ink-600 bg-ink-850 p-4">
            <h2 className="mb-2 text-sm font-semibold text-ink-100">Layout conflict</h2>
            <p className="mb-4 text-[12px] text-ink-300">{conflict}</p>
            <div className="flex justify-end gap-2">
              <Button variant="subtle" disabled={busy} onClick={() => void performReload()}>
                Reload (discard mine)
              </Button>
              <Button variant="primary" disabled={busy} onClick={() => void performSaveAsCopy()}>
                Save as copy
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
