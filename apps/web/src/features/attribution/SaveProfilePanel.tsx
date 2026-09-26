import { useState } from 'react';
import { useAuthStore } from '../../stores/authStore';
import { useHeroStore, heroesForProject } from '../../stores/heroStore';
import { useOfficeStore, visibleProjects } from '../../stores/officeStore';
import { useRequireAdmin } from '../auth/useRequireAdmin';
import { Button, Empty } from '../../components/ui';
import { AckTimeoutError } from '../../lib/socket';
import { PAIR_TO_CHANGE_MESSAGE } from '../../lib/auth';
import { saveProfileToProject } from './api';
import { describeSaveResult, describeSaveTarget } from './reducer';

/**
 * Settings → Attribution: "Save profile to project" (M8 8k/8l, docs/design/runner-and-helpdesk.md
 * §6.4), one button per floor. Demo mode has no runner to save to, so it shows a plain notice instead
 * of buttons that would only ever fail. Every confirm/toast string is built from `reducer.ts`'s pure
 * helpers so the copy is covered by `reducer.test.ts` without a socket in the loop.
 */
export function SaveProfilePanel() {
  const connection = useOfficeStore((s) => s.connection);
  const projects = useOfficeStore((s) => s.projects);
  const heroes = useHeroStore((s) => s.heroes);
  const showToast = useAuthStore((s) => s.showToast);
  const { guard } = useRequireAdmin();
  const [saving, setSaving] = useState<string | null>(null);

  if (connection === 'demo') return <Empty>Demo mode has no runner to save a profile to.</Empty>;

  const floors = visibleProjects(projects);
  if (floors.length === 0) return <Empty>No floors yet.</Empty>;

  async function attemptSave(projectId: string, cwd: string, overwrite: boolean): Promise<void> {
    setSaving(projectId);
    try {
      const result = await saveProfileToProject(projectId, overwrite);
      const { message, needsOverwriteConfirm } = describeSaveResult(result);
      if (needsOverwriteConfirm) {
        if (window.confirm(`${message}\n\nOverwrite ${cwd}/${result.relativePath}?`)) {
          await attemptSave(projectId, cwd, true);
          return;
        }
        showToast(message);
        return;
      }
      showToast(message);
    } catch (err) {
      if (err instanceof AckTimeoutError) showToast(PAIR_TO_CHANGE_MESSAGE);
      else showToast(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="space-y-2">
      {floors.map((project) => {
        const items = describeSaveTarget(project.name, Boolean(project.layoutId), heroesForProject(heroes, project.id).length);
        const busy = saving === project.id;
        return (
          <div key={project.id} className="flex items-center justify-between gap-2 rounded-md border border-ink-700 bg-ink-850 p-2.5 text-[11px] text-ink-200">
            <div className="space-y-0.5">
              <p className="text-ink-100">{project.name}</p>
              <p className="text-ink-400">Would save: {items.join(', ')}.</p>
            </div>
            <Button
              variant="subtle"
              disabled={busy}
              onClick={() =>
                guard(() => {
                  const path = `${project.cwd}/.tagconn/office.json`;
                  if (!window.confirm(`Save this office profile to ${path}?\n\nIncludes: ${items.join(', ')}.\nNever includes secrets or absolute host paths.`)) return;
                  void attemptSave(project.id, project.cwd, false);
                })
              }
            >
              {busy ? 'Saving…' : 'Save profile to project'}
            </Button>
          </div>
        );
      })}
    </div>
  );
}
