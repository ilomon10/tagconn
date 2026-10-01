import { useEffect, useState, type ReactNode } from 'react';
import { TopBar } from './TopBar';
import { useOverlayStore, type OverlayId } from './overlays';
import { OfficeView } from '../features/office/OfficeView';
import { KanbanBoard } from '../features/board/KanbanBoard';
import { EventLog } from '../features/log/EventLog';
import { RolesEditor } from '../features/roles/RolesEditor';
import { SettingsPanel } from '../features/settings/SettingsPanel';
import { QuestBoard } from '../features/quests/QuestBoard';
import { OfficeEditor } from '../features/editor/OfficeEditor';
import { ReceptionistPanel } from '../features/receptionist/ReceptionistPanel';
import { AttributionToastHost } from '../features/attribution/AttributionToastHost';
import { Sheet } from '../components/Sheet';

const OVERLAY_VIEW: Record<OverlayId, { title: string; render: () => ReactNode; wide?: boolean }> = {
  board: { title: 'Board', render: () => <KanbanBoard /> },
  log: { title: 'Log', render: () => <EventLog /> },
  quests: { title: 'Quests', render: () => <QuestBoard /> },
  roles: { title: 'Roles', render: () => <RolesEditor /> },
  settings: { title: 'Settings', render: () => <SettingsPanel /> },
};

export function App() {
  const overlay = useOverlayStore((s) => s.open);
  const closeOverlay = useOverlayStore((s) => s.close);
  // The Hall Planner (M7 office editor) is a full-screen modal opened from the menu
  // (docs/design/guild-hall.md section 5); it used to float over the canvas and covered the roster.
  const [editorOpen, setEditorOpen] = useState(false);

  // `#board` etc. still deep-link: any hash change (including `location.hash = 'settings'`) re-syncs.
  useEffect(() => {
    const sync = () => useOverlayStore.getState().syncFromHash();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);

  const view = overlay ? OVERLAY_VIEW[overlay] : null;
  return (
    <div className="flex h-full flex-col">
      <TopBar onOpenPlanner={() => setEditorOpen(true)} />
      {/* The office is always mounted and visible; Board/Log/Quests/Roles/Settings open over it as sheets. */}
      <main className="relative min-h-0 flex-1">
        <OfficeView active />
      </main>
      {overlay && view && (
        <Sheet key={overlay} id={overlay} title={view.title} onClose={closeOverlay} wide={view.wide}>
          {view.render()}
        </Sheet>
      )}
      {editorOpen && <OfficeEditor onClose={() => setEditorOpen(false)} />}
      <ReceptionistPanel />
      <AttributionToastHost />
    </div>
  );
}
