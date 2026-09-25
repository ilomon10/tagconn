import { useState } from 'react';
import { ZONES, type Zone } from '@tagconn/shared';
import { DEFAULT_ZONE_RECTS, type Rect } from '../../game/map/officeMap';
import { Button, Input, Select } from '../../components/ui';

/** string → string map editor (agents.typeToRole). */
export function KeyValueEditor({
  value,
  onChange,
  keyLabel,
  valueLabel,
  valueOptions,
}: {
  value: Record<string, string>;
  onChange: (v: Record<string, string>) => void;
  keyLabel: string;
  valueLabel: string;
  valueOptions?: string[];
}) {
  const entries = Object.entries(value);
  const [newKey, setNewKey] = useState('');
  const setEntry = (i: number, k: string, v: string) => onChange(Object.fromEntries(entries.map((e, j) => (j === i ? [k, v] : e))));
  const remove = (i: number) => onChange(Object.fromEntries(entries.filter((_, j) => j !== i)));
  const add = () => {
    const k = newKey.trim();
    if (!k || k in value) return;
    onChange({ ...value, [k]: valueOptions?.[0] ?? '' });
    setNewKey('');
  };
  return (
    <div className="space-y-1.5">
      <div className="grid grid-cols-[1fr_1fr_auto] gap-1.5 text-[10px] text-ink-400">
        <span>{keyLabel}</span>
        <span>{valueLabel}</span>
        <span className="w-7" />
      </div>
      {entries.map(([k, v], i) => (
        <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-1.5">
          <Input className="font-pixel" value={k} onChange={(e) => setEntry(i, e.target.value, v)} />
          {valueOptions ? (
            <Select value={v} onChange={(e) => setEntry(i, k, e.target.value)}>
              {!valueOptions.includes(v) && <option>{v}</option>}
              {valueOptions.map((o) => (
                <option key={o}>{o}</option>
              ))}
            </Select>
          ) : (
            <Input value={v} onChange={(e) => setEntry(i, k, e.target.value)} />
          )}
          <Button variant="ghost" className="w-7 justify-center text-red-300" onClick={() => remove(i)} aria-label="Remove">
            ✕
          </Button>
        </div>
      ))}
      <div className="flex gap-1.5">
        <Input className="font-pixel" placeholder={`new ${keyLabel}`} value={newKey} onChange={(e) => setNewKey(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
        <Button onClick={add}>Add</Button>
      </div>
    </div>
  );
}

/** Zone rectangle overrides (office.zones). */
export function ZoneRectsEditor({ value, onChange }: { value: Record<string, Rect>; onChange: (v: Record<string, Rect>) => void }) {
  const used = Object.keys(value);
  const free = ZONES.filter((z) => !used.includes(z));
  const setRect = (zone: string, k: keyof Rect, n: number) => onChange({ ...value, [zone]: { ...value[zone]!, [k]: n } });
  const remove = (zone: string) => {
    const next = { ...value };
    delete next[zone];
    onChange(next);
  };
  return (
    <div className="space-y-1.5">
      {used.length === 0 && <p className="text-[11px] text-ink-400">Using the default layout.</p>}
      {used.map((zone) => (
        <div key={zone} className="grid grid-cols-[8rem_repeat(4,minmax(0,1fr))_auto] items-center gap-1.5 text-[11px]">
          <span className="font-pixel text-ink-300">{zone}</span>
          {(['x', 'y', 'w', 'h'] as const).map((k) => (
            <label key={k} className="flex items-center gap-1">
              <span className="text-ink-400">{k}</span>
              <Input type="number" value={value[zone]![k]} onChange={(e) => setRect(zone, k, Number(e.target.value) || 0)} />
            </label>
          ))}
          <Button variant="ghost" className="text-red-300" onClick={() => remove(zone)} aria-label="Remove override">
            ✕
          </Button>
        </div>
      ))}
      {free.length > 0 && (
        <Select
          className="w-56"
          value=""
          onChange={(e) => {
            const z = e.target.value as Zone;
            if (z) onChange({ ...value, [z]: { ...DEFAULT_ZONE_RECTS[z] } });
          }}
        >
          <option value="">+ Override a zone…</option>
          {free.map((z) => (
            <option key={z}>{z}</option>
          ))}
        </Select>
      )}
    </div>
  );
}
