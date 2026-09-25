import { useEffect, useState } from 'react';
import { TopBar, TABS, type Tab } from './TopBar';
import { OfficeView } from '../features/office/OfficeView';
import { KanbanBoard } from '../features/board/KanbanBoard';
import { EventLog } from '../features/log/EventLog';
import { RolesEditor } from '../features/roles/RolesEditor';
import { SettingsPanel } from '../features/settings/SettingsPanel';
import { OfficeEditor } from '../features/editor/OfficeEditor';

const tabFromHash = (): Tab => {
  const h = window.location.hash.replace('#', '') as Tab;
  return TABS.some((t) => t.id === h) ? h : 'office';
};

export function App() {
  const [tab, setTab] = useState<Tab>(tabFromHash);
  // The Hall Planner (M7 office editor) is a full-screen modal opened from the top bar
  // (docs/design/guild-hall.md section 5); it used to float over the canvas and covered the roster.
  const [editorOpen, setEditorOpen] = useState(false);

  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const select = (t: Tab) => {
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${t}`);
    setTab(t);
  };

  return (
    <div className="flex h-full min-w-[1000px] flex-col">
      <TopBar tab={tab} onTab={select} onOpenPlanner={() => setEditorOpen(true)} />
      <main className="relative min-h-0 flex-1">
        {/* The office stays mounted so the Phaser game keeps its state while other tabs are open. */}
        {/* Hidden with visibility (not display:none) so the WebGL canvas never resizes to 0×0. */}
        <div className={tab === 'office' ? 'h-full' : 'invisible pointer-events-none absolute inset-0'} aria-hidden={tab !== 'office'}>
          <OfficeView active={tab === 'office'} />
        </div>
        {tab === 'board' && <KanbanBoard />}
        {tab === 'log' && <EventLog />}
        {tab === 'roles' && <RolesEditor />}
        {tab === 'settings' && <SettingsPanel />}
      </main>
      {editorOpen && <OfficeEditor onClose={() => setEditorOpen(false)} />}
    </div>
  );
}
