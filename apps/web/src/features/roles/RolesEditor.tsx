import { useEffect, useState } from 'react';
import { RoleSchema, ZONES, type Role } from '@tagconn/shared';
import { useSettingsStore } from '../../stores/settingsStore';
import { deleteRole, saveRole, syncRoles } from '../../lib/commands';
import { Badge, Button, Checkbox, Dot, Field, Input, Panel, Select, Textarea, cx } from '../../components/ui';

const MODELS = ['inherit', 'opus', 'sonnet', 'haiku'] as const;

interface Draft {
  role: Role;
  tools: string;
  isNew: boolean;
}

const toDraft = (role: Role, isNew = false): Draft => ({ role, tools: role.tools === null ? 'all' : role.tools.join(', '), isNew });

const blankRole = (): Role => ({
  name: 'new-role',
  title: 'New Role',
  description: 'Describe when Claude should delegate to this role.',
  model: 'inherit',
  tools: null,
  prompt: 'You are …',
  zone: 'desks',
  color: '#4f8cff',
  sprite: 0,
  enabled: true,
  syncToClaude: true,
  builtin: false,
});

function parseTools(s: string): string[] | null {
  const t = s.trim();
  if (!t || t.toLowerCase() === 'all') return null;
  return t
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

function RoleList({ roles, current, onPick, onNew }: { roles: Role[]; current?: string; onPick: (r: Role) => void; onNew: () => void }) {
  return (
    <Panel
      title="Roles"
      className="flex min-h-0 w-64 shrink-0 flex-col"
      actions={
        <Button variant="primary" onClick={onNew}>
          + New
        </Button>
      }
    >
      <ul className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {roles.map((r) => (
          <li key={r.name}>
            <button
              type="button"
              onClick={() => onPick(r)}
              className={cx('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs', current === r.name ? 'bg-ink-700' : 'hover:bg-ink-800', !r.enabled && 'opacity-50')}
            >
              <Dot color={r.color} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{r.title}</span>
                <span className="block truncate font-pixel text-[10px] text-ink-400">{r.name}</span>
              </span>
              {r.builtin && <Badge>builtin</Badge>}
            </button>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

export function RolesEditor() {
  const roles = useSettingsStore((s) => s.roles);
  const [draft, setDraft] = useState<Draft | null>(() => (roles[0] ? toDraft(roles[0]) : null));
  const [errors, setErrors] = useState<string[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [syncResult, setSyncResult] = useState<{ written: string[]; removed: string[] } | null>(null);

  // Keep the form pointed at a role that still exists after remote changes.
  useEffect(() => {
    if (draft && !draft.isNew && !roles.some((r) => r.name === draft.role.name)) setDraft(roles[0] ? toDraft(roles[0]) : null);
  }, [roles, draft]);

  const set = <K extends keyof Role>(k: K, v: Role[K]) => setDraft((d) => (d ? { ...d, role: { ...d.role, [k]: v } } : d));

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(true);
    setStatus(null);
    try {
      await fn();
      setStatus(label);
    } catch (err) {
      setErrors([err instanceof Error ? err.message : String(err)]);
    } finally {
      setBusy(false);
    }
  };

  const onSave = () => {
    if (!draft) return;
    const candidate = { ...draft.role, tools: parseTools(draft.tools) };
    const parsed = RoleSchema.safeParse(candidate);
    if (!parsed.success) {
      setErrors(parsed.error.issues.map((i) => `${i.path.join('.') || 'role'}: ${i.message}`));
      return;
    }
    if (draft.isNew && roles.some((r) => r.name === parsed.data.name)) {
      setErrors([`A role named "${parsed.data.name}" already exists`]);
      return;
    }
    setErrors([]);
    void run('Saved', async () => {
      const saved = await saveRole(parsed.data);
      setDraft(toDraft(saved));
    });
  };

  const onDelete = () => {
    if (!draft) return;
    if (draft.isNew) {
      setDraft(roles[0] ? toDraft(roles[0]) : null);
      return;
    }
    if (!window.confirm(`Delete role "${draft.role.name}"? Its managed ~/.claude/agents file is removed on next sync.`)) return;
    void run('Deleted', () => deleteRole(draft.role.name));
  };

  const onSync = () =>
    void run('Synced', async () => {
      setSyncResult(await syncRoles());
    });

  const r = draft?.role;
  return (
    <div className="flex h-full min-h-0 gap-4 p-4">
      <RoleList roles={roles} current={draft?.isNew ? undefined : r?.name} onPick={(x) => (setDraft(toDraft(x)), setErrors([]))} onNew={() => setDraft(toDraft(blankRole(), true))} />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto">
        {r && draft ? (
          <Panel
            title={draft.isNew ? 'New role' : `Edit ${r.title}`}
            actions={
              <>
                {status && <span className="text-[11px] text-emerald-300">{status}</span>}
                <Button variant="danger" onClick={onDelete} disabled={busy}>
                  {draft.isNew ? 'Discard' : 'Delete'}
                </Button>
                <Button variant="primary" onClick={onSave} disabled={busy}>
                  Save
                </Button>
              </>
            }
          >
            <div className="grid grid-cols-2 gap-3 p-3 xl:grid-cols-3">
              <Field label="Name (slug)" hint="Also the Claude subagent name / file name">
                <Input value={r.name} disabled={!draft.isNew} onChange={(e) => set('name', e.target.value)} />
              </Field>
              <Field label="Title">
                <Input value={r.title} onChange={(e) => set('title', e.target.value)} />
              </Field>
              <Field label="Model">
                <Select value={r.model} onChange={(e) => set('model', e.target.value as Role['model'])}>
                  {MODELS.map((m) => (
                    <option key={m}>{m}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Description" hint="Tells Claude when to delegate to this role">
                <Input value={r.description} onChange={(e) => set('description', e.target.value)} />
              </Field>
              <Field label="Tools" hint='Comma list, or "all"'>
                <Input value={draft.tools} onChange={(e) => setDraft({ ...draft, tools: e.target.value })} placeholder="all" />
              </Field>
              <Field label="Zone">
                <Select value={r.zone} onChange={(e) => set('zone', e.target.value as Role['zone'])}>
                  {ZONES.map((z) => (
                    <option key={z}>{z}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Color">
                <div className="flex items-center gap-2">
                  <input type="color" className="h-7 w-10 cursor-pointer rounded border border-ink-600 bg-ink-900" value={r.color} onChange={(e) => set('color', e.target.value)} />
                  <Input value={r.color} onChange={(e) => set('color', e.target.value)} />
                </div>
              </Field>
              <Field label="Sprite index" hint="Hair style variant">
                <Input type="number" min={0} value={r.sprite} onChange={(e) => set('sprite', Math.max(0, Math.floor(Number(e.target.value) || 0)))} />
              </Field>
              <div className="flex flex-col justify-center gap-2">
                <Checkbox checked={r.enabled} onChange={(v) => set('enabled', v)} label="Enabled" />
                <Checkbox checked={r.syncToClaude} onChange={(v) => set('syncToClaude', v)} label="Sync to ~/.claude/agents" />
              </div>
              <div className="col-span-full">
                <Field label="Prompt (system prompt / agent body)">
                  <Textarea rows={12} value={r.prompt} onChange={(e) => set('prompt', e.target.value)} />
                </Field>
              </div>
            </div>
            {errors.length > 0 && (
              <ul className="mx-3 mb-3 rounded-md border border-red-800 bg-red-950/50 p-2 text-[11px] text-red-200">
                {errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            )}
          </Panel>
        ) : (
          <Panel>
            <p className="p-6 text-xs text-ink-400">Select a role or create a new one.</p>
          </Panel>
        )}

        <Panel
          title="Sync to Claude"
          actions={
            <Button variant="primary" onClick={onSync} disabled={busy}>
              Sync to Claude
            </Button>
          }
        >
          <div className="p-3 text-[11px] text-ink-300">
            <p>Writes enabled roles with “sync” on to <code className="font-pixel">~/.claude/agents/&lt;name&gt;.md</code> and removes managed files of deleted roles.</p>
            {syncResult && (
              <div className="mt-2 grid grid-cols-2 gap-3">
                <div>
                  <h4 className="mb-1 font-semibold text-emerald-300">Written ({syncResult.written.length})</h4>
                  <ul className="space-y-0.5 font-pixel">{syncResult.written.map((f) => <li key={f}>{f}</li>)}</ul>
                </div>
                <div>
                  <h4 className="mb-1 font-semibold text-red-300">Removed ({syncResult.removed.length})</h4>
                  <ul className="space-y-0.5 font-pixel">{syncResult.removed.map((f) => <li key={f}>{f}</li>)}</ul>
                </div>
              </div>
            )}
          </div>
        </Panel>
      </div>
    </div>
  );
}
