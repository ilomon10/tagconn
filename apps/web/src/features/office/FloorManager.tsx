import { useEffect, useState } from 'react';
import type { Project } from '@tagconn/shared';
import { useOfficeStore, visibleProjects } from '../../stores/officeStore';
import { patchProject } from '../../lib/commands';
import { Badge, Button, Checkbox, Empty, Input, Panel } from '../../components/ui';

function FloorRow({ project }: { project: Project }) {
  const [name, setName] = useState(project.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Adopt renames that land from elsewhere (another tab, or the server) while this input is idle.
  useEffect(() => setName(project.name), [project.name]);

  const rename = async () => {
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
            if (e.key === 'Escape') setName(project.name);
          }}
        />
        {project.archived && <Badge className="shrink-0 bg-ink-700 text-ink-400">archived</Badge>}
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

export function FloorManager({ onClose }: { onClose: () => void }) {
  const projects = useOfficeStore((s) => s.projects);
  const selected = useOfficeStore((s) => s.selectedProjectId);
  const [showArchived, setShowArchived] = useState(false);
  const list = visibleProjects(projects, { selectedId: selected, showArchived });

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-20" onClick={onClose}>
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
          {list.length === 0 ? (
            <Empty>No floors yet — start a Claude Code session to see one appear.</Empty>
          ) : (
            <ul className="max-h-[60vh] space-y-1 overflow-y-auto p-2">
              {list.map((p) => (
                <FloorRow key={p.id} project={p} />
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}
