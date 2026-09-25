import { useEffect, useRef, useState } from 'react';
import type { Project } from '@tagconn/shared';
import { ALL_FLOORS, useOfficeStore, visibleProjects } from '../../stores/officeStore';
import { MULTIVERSE_FLOOR, MULTIVERSE_ICON } from '../../lib/floors';
import { patchProject } from '../../lib/commands';
import { Badge, Button, Checkbox, Empty, Input, Panel, cx } from '../../components/ui';
import { OfficeEditor } from '../editor/OfficeEditor';

function FloorRow({ project, onEdit }: { project: Project; onEdit: () => void }) {
  const [name, setName] = useState(project.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Escape blurs the input to give clear "cancelled" feedback, but blur fires onBlur (rename)
  // synchronously, before the setName(project.name) reset above it has been re-rendered — so rename()
  // would otherwise still see the stale, pre-Escape text and save it. This flag makes that one blur a
  // no-op instead.
  const cancelledRef = useRef(false);

  // Adopt renames that land from elsewhere (another tab, or the server) while this input is idle.
  useEffect(() => setName(project.name), [project.name]);

  const rename = async () => {
    if (cancelledRef.current) {
      cancelledRef.current = false;
      return;
    }
    const trimmed = name.trim();
    if (!trimmed || trimmed === project.name) {
      setName(project.name);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await patchProject(project.id, { name: trimmed });
    } catch (err) {
      setName(project.name);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const toggleArchived = async () => {
    setBusy(true);
    setError(null);
    try {
      await patchProject(project.id, { archived: !project.archived });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="rounded-md px-2 py-1.5 hover:bg-ink-800">
      <div className="flex items-center gap-2">
        <Input
          className="min-w-0 flex-1"
          value={name}
          disabled={busy}
          onChange={(e) => setName(e.target.value)}
          onBlur={rename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') {
              cancelledRef.current = true;
              setName(project.name);
              e.currentTarget.blur();
            }
          }}
        />
        {project.archived && <Badge className="shrink-0 bg-ink-700 text-ink-400">archived</Badge>}
        <Button variant="subtle" className="shrink-0" disabled={busy} onClick={onEdit} title="Draw and edit this floor's plan">
          Edit floor
        </Button>
        <Button variant={project.archived ? 'primary' : 'subtle'} className="shrink-0" disabled={busy} onClick={toggleArchived}>
          {project.archived ? 'Unarchive' : 'Archive'}
        </Button>
      </div>
      <div className="mt-0.5 flex items-center gap-2 pl-0.5">
        <span className="truncate font-pixel text-[10px] text-ink-400" title={project.cwd}>
          {project.cwd}
        </span>
        {error && <span className="shrink-0 text-[10px] text-red-300">{error}</span>}
      </div>
    </li>
  );
}

/**
 * The Multiverse's row in the floor picker (docs/design/living-office.md section 6.3: "The floor
 * picker lists 'The Multiverse' first, with an '∞' icon"). Unlike a real floor it can't be renamed,
 * archived or edited — clicking it just travels there and closes the picker, same as a stairs click.
 */
function MultiverseRow({ selected, onSelect }: { selected: boolean; onSelect: () => void }) {
  return (
    <li className={cx('rounded-md px-2 py-1.5', selected ? 'bg-ink-700' : 'hover:bg-ink-800')}>
      <button type="button" className="flex w-full items-center gap-2 text-left" onClick={onSelect}>
        <span aria-hidden className="text-sm">
          {MULTIVERSE_ICON}
        </span>
        <span className="flex-1 truncate text-xs font-semibold text-ink-100">{MULTIVERSE_FLOOR.name}</span>
        {selected && <Badge>current</Badge>}
      </button>
    </li>
  );
}

export function FloorManager({ onClose }: { onClose: () => void }) {
  const projects = useOfficeStore((s) => s.projects);
  const selected = useOfficeStore((s) => s.selectedProjectId);
  const selectProject = useOfficeStore((s) => s.selectProject);
  const [showArchived, setShowArchived] = useState(false);
  // "Edit floor" opens the Hall Planner targeted at a specific row (7g). Self-contained here (rather
  // than plumbed through a callback prop) so it works regardless of which screen renders this panel.
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const list = visibleProjects(projects, { selectedId: selected, showArchived });

  return (
    <>
      <div
        className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-20"
        onClick={onClose}
        data-modal="floor-manager"
        aria-modal="true"
        role="dialog"
      >
        <div className="w-full max-w-xl" onClick={(e) => e.stopPropagation()}>
          <Panel
            title="Manage floors"
            actions={
              <Button variant="ghost" onClick={onClose} aria-label="Close">
                ✕
              </Button>
            }
          >
            <div className="flex items-center justify-between border-b border-ink-700 px-3 py-2">
              <Checkbox checked={showArchived} onChange={setShowArchived} label="Show archived" />
              <span className="text-[11px] text-ink-400">
                {list.length} floor{list.length === 1 ? '' : 's'}
              </span>
            </div>
            <ul className="max-h-[60vh] space-y-1 overflow-y-auto p-2">
              <MultiverseRow
                selected={selected === ALL_FLOORS}
                onSelect={() => {
                  selectProject(ALL_FLOORS);
                  onClose();
                }}
              />
              {list.length === 0 ? (
                <li>
                  <Empty>No floors yet — start a Claude Code session to see one appear.</Empty>
                </li>
              ) : (
                list.map((p) => <FloorRow key={p.id} project={p} onEdit={() => setEditingProjectId(p.id)} />)
              )}
            </ul>
          </Panel>
        </div>
      </div>
      {editingProjectId && <OfficeEditor targetProjectId={editingProjectId} onClose={() => setEditingProjectId(null)} />}
    </>
  );
}
