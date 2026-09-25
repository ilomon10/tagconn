import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { HOOK_EVENTS, MASKED_SECRET, SettingsSchema, type ActivityRule, type Settings } from '@tagconn/shared';
import { useSettingsStore } from '../../stores/settingsStore';
import { resetSettings, updateSettings } from '../../lib/commands';
import { diffSettings, isGuiImmutable, isRestartRequired, patchKeys, restartKeysIn } from '../../lib/settingsPatch';
import type { Rect } from '../../game/map/officeMap';
import { Badge, Button, Checkbox, Field, Input, Panel, Select, Textarea } from '../../components/ui';
import { ENUM_OPTIONS, KEY_HINTS, NUMBER_STEP, SECTION_LABELS, humanize } from './meta';
import { RulesTable } from './RulesTable';
import { KeyValueEditor, ZoneRectsEditor } from './RecordEditors';

type Section = keyof Settings;
type Setter = (section: Section, key: string, value: unknown) => void;

const RestartBadge = () => <Badge className="bg-amber-500/20 text-amber-300">restart required</Badge>;

function StringList({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  // Keep raw text while typing so blank lines don't vanish mid-edit.
  const [text, setText] = useState(value.join('\n'));
  useEffect(() => {
    if (text.split('\n').map((s) => s.trim()).filter(Boolean).join('\n') !== value.join('\n')) setText(value.join('\n'));
  }, [value]);
  return (
    <Textarea
      rows={Math.min(6, Math.max(2, value.length + 1))}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onChange(e.target.value.split('\n').map((s) => s.trim()).filter(Boolean));
      }}
    />
  );
}

function EventChecklist({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const all = [...new Set([...HOOK_EVENTS, ...value])];
  return (
    <div className="grid grid-cols-2 gap-1.5 xl:grid-cols-3">
      {all.map((ev) => (
        <Checkbox key={ev} checked={value.includes(ev)} label={<span className="font-pixel text-[11px]">{ev}</span>} onChange={(on) => onChange(on ? [...value, ev] : value.filter((x) => x !== ev))} />
      ))}
    </div>
  );
}

/** Read-only view of a key that is managed via config file / env. */
function ReadOnlyValue({ path, value }: { path: string; value: unknown }) {
  let text: string;
  if (path === 'server.hookToken') text = value === '' ? '(not set — no hook auth)' : MASKED_SECRET;
  else if (Array.isArray(value)) text = value.join(', ') || '(empty)';
  else if (value && typeof value === 'object') text = JSON.stringify(value);
  else text = String(value);
  return <Input readOnly disabled className="w-full cursor-not-allowed font-pixel opacity-70" value={text} title="Set via config file / env" />;
}

/** Renders the right control for one settings leaf. */
function LeafControl({ section, k, value, set, roles }: { section: Section; k: string; value: unknown; set: Setter; roles: string[] }) {
  const path = `${section}.${k}`;
  const onChange = (v: unknown) => set(section, k, v);
  const enumOpts = ENUM_OPTIONS[path];

  if (isGuiImmutable(path)) return <ReadOnlyValue path={path} value={value} />;
  if (path === 'ingest.enabledEvents') return <EventChecklist value={value as string[]} onChange={onChange} />;
  if (path === 'agents.typeToRole')
    return <KeyValueEditor value={value as Record<string, string>} onChange={onChange} keyLabel="agent_type" valueLabel="role" valueOptions={roles} />;
  if (path === 'office.zones') return <ZoneRectsEditor value={value as Record<string, Rect>} onChange={onChange} />;
  if (enumOpts)
    return (
      <Select value={String(value)} onChange={(e) => onChange(e.target.value)}>
        {enumOpts.map((o) => (
          <option key={o}>{o}</option>
        ))}
      </Select>
    );
  if (typeof value === 'boolean') return <Checkbox checked={value} onChange={onChange} label={value ? 'On' : 'Off'} />;
  if (typeof value === 'number')
    return <Input type="number" step={NUMBER_STEP[path] ?? 1} value={Number.isFinite(value) ? value : ''} onChange={(e) => onChange(e.target.value === '' ? NaN : Number(e.target.value))} />;
  if (Array.isArray(value)) return <StringList value={value as string[]} onChange={onChange} />;
  if (typeof value === 'string')
    return <Input type={path === 'server.hookToken' ? 'password' : 'text'} autoComplete="off" className="font-pixel" value={value} onChange={(e) => onChange(e.target.value)} />;
  return <Textarea rows={3} value={JSON.stringify(value, null, 2)} readOnly />;
}

const WIDE = new Set(['ingest.enabledEvents', 'ingest.redactPatterns', 'agents.typeToRole', 'office.zones', 'server.corsOrigins', 'runner.allowedProjectDirs']);

function SectionPanel({ section, values, base, set, roles }: { section: Section; values: Record<string, unknown>; base: Record<string, unknown>; set: Setter; roles: string[] }) {
  const meta = SECTION_LABELS[section];
  const body: ReactNode =
    section === 'activity' ? (
      <RulesTable rules={values.rules as ActivityRule[]} onChange={(r) => set('activity', 'rules', r)} />
    ) : (
      <div className="grid grid-cols-2 gap-x-4 gap-y-3 xl:grid-cols-3">
        {Object.entries(values).map(([k, v]) => {
          const path = `${section}.${k}`;
          const dirty = JSON.stringify(v) !== JSON.stringify(base[k]);
          return (
            <div key={k} className={WIDE.has(path) ? 'col-span-full' : undefined}>
              <Field
                label={
                  <span className={dirty ? 'text-cozy' : undefined}>
                    {humanize(k)}
                    {dirty && ' •'}
                  </span>
                }
                hint={isGuiImmutable(path) ? `Set via config file / env${KEY_HINTS[path] ? ` — ${KEY_HINTS[path]}` : ''}` : KEY_HINTS[path]}
                badge={
                  <>
                    {isRestartRequired(path) && <RestartBadge />}
                    {isGuiImmutable(path) && <Badge className="bg-ink-700 text-ink-400">read-only</Badge>}
                  </>
                }
              >
                <LeafControl section={section} k={k} value={v} set={set} roles={roles} />
              </Field>
            </div>
          );
        })}
      </div>
    );
  return (
    <Panel title={meta.title} actions={<span className="text-[10px] text-ink-400">{meta.hint}</span>}>
      <div className="p-3">{body}</div>
    </Panel>
  );
}

export function SettingsPanel() {
  const settings = useSettingsStore((s) => s.settings);
  const loaded = useSettingsStore((s) => s.settingsLoaded);
  const roleNames = useSettingsStore((s) => s.roles.map((r) => r.name).join(','));
  const [base, setBase] = useState(settings);
  const [draft, setDraft] = useState(settings);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'warn' | 'error'; text: string } | null>(null);

  const patch = useMemo(() => diffSettings(base, draft), [base, draft]);
  const changed = patchKeys(patch);
  const dirty = changed.length > 0;
  const remoteChanged = settings !== base;

  // Adopt remote changes automatically unless the user has unsaved edits.
  useEffect(() => {
    if (!dirty && settings !== base) {
      setBase(settings);
      setDraft(settings);
    }
  }, [settings, base, dirty]);

  const set: Setter = (section, key, value) =>
    setDraft((d) => ({ ...d, [section]: { ...(d[section] as Record<string, unknown>), [key]: value } }) as Settings);

  const save = async () => {
    const parsed = SettingsSchema.safeParse(draft);
    if (!parsed.success) {
      setMessage({ tone: 'error', text: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(' · ') });
      return;
    }
    for (const r of draft.activity.rules) {
      try {
        new RegExp(r.tool);
        if (r.input) new RegExp(r.input);
      } catch {
        setMessage({ tone: 'error', text: `Invalid regex in activity rule "${r.tool}"` });
        return;
      }
    }
    setBusy(true);
    try {
      const restart = restartKeysIn(patch);
      const next = await updateSettings(patch);
      setBase(next);
      setDraft(next);
      setMessage(
        restart.length
          ? { tone: 'warn', text: `Saved. Restart the server to apply: ${restart.join(', ')}` }
          : { tone: 'ok', text: `Saved ${changed.length} change${changed.length === 1 ? '' : 's'} — applied live.` },
      );
    } catch (err) {
      setMessage({ tone: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    if (!window.confirm('Reset ALL settings to their defaults?')) return;
    setBusy(true);
    try {
      const next = await resetSettings();
      setBase(next);
      setDraft(next);
      setMessage({ tone: 'ok', text: 'Settings reset to defaults.' });
    } catch (err) {
      setMessage({ tone: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const roles = roleNames ? roleNames.split(',') : [];
  const toneClass = { ok: 'text-emerald-300', warn: 'text-amber-300', error: 'text-red-300' } as const;

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-ink-700 bg-ink-900 px-4 py-2">
        <h1 className="text-sm font-semibold">Settings</h1>
        {!loaded && <Badge className="bg-ink-700 text-ink-400">defaults (server not loaded)</Badge>}
        {dirty && <span className="text-[11px] text-cozy">{changed.length} unsaved change{changed.length === 1 ? '' : 's'}</span>}
        {dirty && remoteChanged && <span className="text-[11px] text-amber-300">Settings changed elsewhere — saving overwrites those keys.</span>}
        {message && <span className={`truncate text-[11px] ${toneClass[message.tone]}`}>{message.text}</span>}
        <div className="ml-auto flex gap-2">
          <Button variant="danger" onClick={reset} disabled={busy}>
            Reset to defaults
          </Button>
          <Button onClick={() => (setDraft(base), setMessage(null))} disabled={!dirty || busy}>
            Revert
          </Button>
          <Button variant="primary" onClick={save} disabled={!dirty || busy}>
            Save
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        {(Object.keys(draft) as Section[]).map((section) => (
          <SectionPanel
            key={section}
            section={section}
            values={draft[section] as Record<string, unknown>}
            base={base[section] as Record<string, unknown>}
            set={set}
            roles={roles}
          />
        ))}
      </div>
    </div>
  );
}
