import { ACTIVITIES, ZONES, type ActivityRule } from '@tagconn/shared';
import { Button, Input, Select } from '../../components/ui';

function regexError(src: string | undefined): string | null {
  if (!src) return null;
  try {
    new RegExp(src);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : 'invalid regex';
  }
}

export function RulesTable({ rules, onChange }: { rules: ActivityRule[]; onChange: (r: ActivityRule[]) => void }) {
  const update = (i: number, patch: Partial<ActivityRule>) => onChange(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= rules.length) return;
    const next = [...rules];
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  };
  const remove = (i: number) => onChange(rules.filter((_, j) => j !== i));
  const add = () => onChange([...rules, { tool: '.*', activity: 'thinking', bubble: '{tool}' }]);
  const opt = (s: string) => (s.trim() === '' ? undefined : s);

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-md border border-ink-700">
        <table className="w-full text-[11px]">
          <thead className="bg-ink-800 text-left text-ink-400">
            <tr>
              <th className="w-8 px-2 py-1">#</th>
              <th className="px-1 py-1">Tool regex</th>
              <th className="px-1 py-1">Input regex</th>
              <th className="w-28 px-1 py-1">Activity</th>
              <th className="w-32 px-1 py-1">Zone</th>
              <th className="px-1 py-1">Bubble</th>
              <th className="w-24 px-1 py-1" />
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-700/60">
            {rules.map((r, i) => {
              const toolErr = regexError(r.tool);
              const inputErr = regexError(r.input);
              return (
                <tr key={i} className="align-top">
                  <td className="px-2 py-1.5 font-pixel text-ink-400">{i + 1}</td>
                  <td className="px-1 py-1">
                    <Input className={toolErr ? 'border-red-600 font-pixel' : 'font-pixel'} title={toolErr ?? ''} value={r.tool} onChange={(e) => update(i, { tool: e.target.value })} />
                  </td>
                  <td className="px-1 py-1">
                    <Input className={inputErr ? 'border-red-600 font-pixel' : 'font-pixel'} title={inputErr ?? ''} value={r.input ?? ''} placeholder="(any)" onChange={(e) => update(i, { input: opt(e.target.value) })} />
                  </td>
                  <td className="px-1 py-1">
                    <Select value={r.activity} onChange={(e) => update(i, { activity: e.target.value as ActivityRule['activity'] })}>
                      {ACTIVITIES.map((a) => (
                        <option key={a}>{a}</option>
                      ))}
                    </Select>
                  </td>
                  <td className="px-1 py-1">
                    <Select value={r.zone ?? ''} onChange={(e) => update(i, { zone: (opt(e.target.value) as ActivityRule['zone']) ?? undefined })}>
                      <option value="">(role zone)</option>
                      {ZONES.map((z) => (
                        <option key={z}>{z}</option>
                      ))}
                    </Select>
                  </td>
                  <td className="px-1 py-1">
                    <Input value={r.bubble ?? ''} placeholder="{tool} {file} {command}…" onChange={(e) => update(i, { bubble: opt(e.target.value) })} />
                  </td>
                  <td className="whitespace-nowrap px-1 py-1 text-right">
                    <Button variant="ghost" className="px-1.5" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up">
                      ↑
                    </Button>
                    <Button variant="ghost" className="px-1.5" onClick={() => move(i, 1)} disabled={i === rules.length - 1} aria-label="Move down">
                      ↓
                    </Button>
                    <Button variant="ghost" className="px-1.5 text-red-300" onClick={() => remove(i)} aria-label="Remove rule">
                      ✕
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Button onClick={add}>+ Add rule</Button>
    </div>
  );
}
