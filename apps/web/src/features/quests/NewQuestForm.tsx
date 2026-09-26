import { useState } from 'react';
import { RUN_MODELS, type Run, type RunModel } from '@tagconn/shared';
import { ALL_FLOORS, useOfficeStore, visibleProjects } from '../../stores/officeStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useHeroStore, heroesForProject } from '../../stores/heroStore';
import { useRunsStore } from '../../stores/runsStore';
import { useRequireAdmin } from '../auth/useRequireAdmin';
import { Button, Field, Select, Textarea } from '../../components/ui';
import { isProjectDirAllowed, questModeOptions } from './modes';
import { guidanceForError } from './rejectionGuidance';

/**
 * "Post quest" form (docs/design/runner-and-helpdesk.md section 3). An overlay dialog, same
 * convention as `PairingDialog`/`FloorManager` — `data-modal` so `lib/floors.ts`'s `isModalOpen()`
 * suppresses floor hotkeys while it's open.
 */
export function NewQuestForm({ onClose, onCreated, initialFloor }: { onClose: () => void; onCreated: (run: Run) => void; initialFloor?: string }) {
  const projects = useOfficeStore((s) => s.projects);
  const selectedFloor = useOfficeStore((s) => s.selectedProjectId);
  const heroes = useHeroStore((s) => s.heroes);
  const settings = useSettingsStore((s) => s.settings);
  const status = useRunsStore((s) => s.runnerStatus);
  const start = useRunsStore((s) => s.start);
  const { guard } = useRequireAdmin();

  const floors = visibleProjects(projects, { selectedId: selectedFloor });
  const defaultFloor = initialFloor && initialFloor !== ALL_FLOORS ? initialFloor : (floors[0]?.id ?? '');

  const [projectId, setProjectId] = useState(defaultFloor);
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState<RunModel>(settings.runner.defaultModel);
  const modeOptions = questModeOptions(settings.runner.allowedPermissionModes, status);
  const [permissionMode, setPermissionMode] = useState(modeOptions.find((m) => m.allowed)?.mode ?? settings.runner.permissionMode);
  const [heroId, setHeroId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const maxChars = settings.runner.maxPromptChars;
  const allowedDirs = status?.allowedProjectDirs ?? [];
  const heroOptions = projectId ? heroesForProject(heroes, projectId) : [];
  const chosenProject = floors.find((p) => p.id === projectId);
  const dirAllowed = !chosenProject || allowedDirs.length === 0 || isProjectDirAllowed(chosenProject.cwd, allowedDirs);

  const canSubmit = !busy && projectId && prompt.trim().length > 0 && prompt.length <= maxChars && dirAllowed;

  const doStart = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const run = await start({
        projectId,
        prompt: prompt.trim(),
        model,
        permissionMode,
        heroId: heroId || undefined,
      });
      onCreated(run);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? guidanceForError(err.message) : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-16" onClick={onClose} data-modal="new-quest" aria-modal="true">
      <div className="w-full max-w-lg rounded-lg border border-ink-700 bg-ink-850 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center justify-between border-b border-ink-700 px-4 py-3">
          <h2 className="text-sm font-semibold text-ink-100">New quest</h2>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </header>
        <div className="space-y-3 p-4">
          <p className="rounded-md border border-amber-800/60 bg-amber-950/30 px-3 py-2 text-[11px] leading-relaxed text-amber-100">
            Quests run Claude on your machine with your subscription; they ignore the repo's .claude/settings.json and
            .mcp.json.
          </p>

          <Field label="Floor">
            <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="" disabled>
                Choose a floor…
              </option>
              {floors.map((p) => {
                const allowed = allowedDirs.length === 0 || isProjectDirAllowed(p.cwd, allowedDirs);
                return (
                  <option key={p.id} value={p.id} disabled={!allowed} title={allowed ? p.cwd : `Outside the runner's allowed directories: ${p.cwd}`}>
                    {p.name}
                    {allowed ? '' : ' (not allowed)'}
                  </option>
                );
              })}
            </Select>
            {!dirAllowed && (
              <span className="mt-1 block text-[10px] text-red-300">
                This floor is outside the runner's allowed project directories, so the quest would be refused.
              </span>
            )}
          </Field>

          <Field label="Prompt" hint={`${prompt.length} / ${maxChars} characters`}>
            <Textarea rows={5} value={prompt} onChange={(e) => setPrompt(e.target.value.slice(0, maxChars))} placeholder="What should this quest do?" />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Model">
              <Select value={model} onChange={(e) => setModel(e.target.value as RunModel)}>
                {RUN_MODELS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Mode">
              <Select value={permissionMode} onChange={(e) => setPermissionMode(e.target.value as typeof permissionMode)}>
                {modeOptions.map((m) => (
                  <option key={m.mode} value={m.mode} disabled={!m.allowed} title={m.allowed ? m.label : m.reason}>
                    {m.mode}
                    {m.allowed ? '' : ' (unavailable)'}
                  </option>
                ))}
              </Select>
              <span className="mt-1 block text-[10px] text-ink-400">{modeOptions.find((m) => m.mode === permissionMode)?.reason ?? modeOptions.find((m) => m.mode === permissionMode)?.label}</span>
            </Field>
          </div>

          <Field label="Hero (optional)" hint="Hand this quest to a named character instead of the anonymous Guild Master.">
            <Select value={heroId} onChange={(e) => setHeroId(e.target.value)} disabled={heroOptions.length === 0}>
              <option value="">No hero</option>
              {heroOptions.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </Select>
          </Field>

          {error && <p className="text-xs text-red-300">{error}</p>}
        </div>
        <footer className="flex items-center justify-end gap-2 border-t border-ink-700 px-4 py-3">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!canSubmit} onClick={() => guard(doStart)}>
            {busy ? 'Starting…' : 'Start quest'}
          </Button>
        </footer>
      </div>
    </div>
  );
}
