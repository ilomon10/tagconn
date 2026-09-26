import { useState } from 'react';
import type { Project, ReceptionistConversation, ReceptionistScope } from '@tagconn/shared';
import { Button, Select, cx } from '../../components/ui';
import { PROJECT_SCOPE_DISABLED_REASON, projectScopeOptions } from './scope';
import { GuideLink, RECEPTIONIST_GUIDE_URL } from './guideLinks';

const SCOPE_LABEL: Record<ReceptionistScope, string> = { general: 'General', project: 'This project' };

/**
 * Conversation list plus the "new conversation" scope picker (§4.1: "a conversation list and a scope
 * choice"). `projects` is already filtered to real, non-Multiverse floors by the caller.
 */
export function ConversationSidebar({
  conversations,
  activeId,
  onSelect,
  onDelete,
  deletingId,
  projects,
  allowedProjectDirs,
  onCreate,
  createBusy,
  createError,
}: {
  conversations: ReceptionistConversation[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  deletingId: string | null;
  projects: Project[];
  allowedProjectDirs: readonly string[];
  onCreate: (scope: ReceptionistScope, projectId?: string) => void;
  createBusy: boolean;
  createError: string | null;
}) {
  const scopeOptions = projectScopeOptions(projects, allowedProjectDirs);
  const firstAllowed = scopeOptions.find((o) => o.allowed);
  const [scope, setScope] = useState<ReceptionistScope>('general');
  const [projectId, setProjectId] = useState<string>(firstAllowed?.project.id ?? '');

  const create = () => {
    if (createBusy) return;
    if (scope === 'project') {
      if (!projectId) return;
      onCreate('project', projectId);
    } else {
      onCreate('general');
    }
  };

  return (
    <div className="flex w-64 shrink-0 flex-col border-r border-ink-700">
      <div className="space-y-2 border-b border-ink-700 p-2.5">
        <div className="flex items-center gap-1 rounded-lg bg-ink-850 p-0.5">
          {(['general', 'project'] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setScope(s)}
              className={cx('flex-1 rounded-md px-2 py-1 text-[11px]', scope === s ? 'bg-ink-600 text-ink-100' : 'text-ink-400 hover:text-ink-100')}
            >
              {SCOPE_LABEL[s]}
            </button>
          ))}
        </div>
        {scope === 'general' ? (
          <p className="text-[10px] text-ink-400">tagconn &amp; general knowledge — no project files.</p>
        ) : scopeOptions.length === 0 ? (
          <p className="text-[10px] text-ink-400">No floors registered yet.</p>
        ) : (
          <Select aria-label="Project" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            {scopeOptions.map((o) => (
              <option key={o.project.id} value={o.project.id} disabled={!o.allowed} title={o.allowed ? o.project.cwd : PROJECT_SCOPE_DISABLED_REASON}>
                {o.project.name}
                {o.allowed ? '' : ' (not allowed)'}
              </option>
            ))}
          </Select>
        )}
        {scope === 'project' && projectId && !scopeOptions.find((o) => o.project.id === projectId)?.allowed && (
          <p className="text-[10px] text-amber-300">{PROJECT_SCOPE_DISABLED_REASON}</p>
        )}
        <Button
          variant="primary"
          className="w-full justify-center"
          disabled={createBusy || (scope === 'project' && (!projectId || !scopeOptions.find((o) => o.project.id === projectId)?.allowed))}
          onClick={create}
        >
          New conversation
        </Button>
        {createError && <p className="text-[10px] text-red-300">{createError}</p>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {conversations.length === 0 && (
          <div className="space-y-1 p-3 text-[11px] text-ink-300">
            <p>No conversations yet. Ask about this project or tagconn itself — it can read, but never change, anything.</p>
            <GuideLink href={RECEPTIONIST_GUIDE_URL}>Learn more</GuideLink>
          </div>
        )}
        {conversations.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => onSelect(c.id)}
            className={cx(
              'flex w-full items-start gap-1.5 border-b border-ink-800 px-2.5 py-2 text-left text-xs',
              c.id === activeId ? 'bg-ink-800 text-ink-100' : 'text-ink-300 hover:bg-ink-850',
            )}
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate">{c.title}</span>
              <span className="text-[10px] text-ink-400">
                {SCOPE_LABEL[c.scope]}
                {c.busy ? ' · thinking…' : ''}
              </span>
            </span>
            {c.busy && <span className="mt-0.5 size-1.5 shrink-0 motion-safe:animate-pulse rounded-full bg-amber-400" title="A turn is in flight" />}
            <span
              role="button"
              tabIndex={0}
              title="Delete conversation"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(c.id);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.stopPropagation();
                  e.preventDefault();
                  onDelete(c.id);
                }
              }}
              className={cx('shrink-0 rounded px-1 text-ink-500 hover:bg-ink-700 hover:text-red-300', deletingId === c.id && 'opacity-40')}
            >
              ✕
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
