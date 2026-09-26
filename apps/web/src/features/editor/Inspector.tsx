import {
  DEFAULT_WALLED_ROOM_TYPES,
  FURNISH_DENSITIES,
  LAYOUT_LIMITS,
  OFFICE_STYLES,
  ROOM_TYPES,
  isRoomWalled,
  type FurnishDensity,
  type LayoutRoom,
  type OfficeLayoutInput,
  type RoomFurnish,
  type RoomType,
} from '@tagconn/shared';
import type { ThemeDefinition } from '../../game/themes';
import { Button, Checkbox, Field, Input, Select } from '../../components/ui';

const int = (v: string, fallback: number) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
};

/** Rooms that hold neither seats nor decor (stairs/hall are open floor, not "furnished"). */
const UNFURNISHABLE: readonly RoomType[] = ['stairs', 'hall'];

/** "seats/desks count" label per room type (M8 8n): matches what `recipes.ts` actually places there. */
const SEAT_LABEL: Partial<Record<RoomType, string>> = {
  desks: 'Desks',
  'pm-office': 'Desks',
  'server-room': 'Racks',
  'qa-lab': 'Benches',
  'review-booth': 'Benches',
};
const seatLabel = (type: RoomType) => SEAT_LABEL[type] ?? 'Seats';

const pct = (v: number | undefined, fallback: number) => Math.round((v ?? fallback) * 100);

/** A plain HTML range slider styled like the other inspector fields (no dedicated `Slider` primitive yet). */
function RangeField({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <Field label={label}>
      <input
        type="range"
        min={0}
        max={100}
        value={value}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
        className="w-full accent-[#f5c07a]"
      />
    </Field>
  );
}

/** Density select shared by the layout-wide defaults and the per-room override, with a "use the
 * default" blank option for the per-room one. */
function DensityField({ value, onChange, allowDefault }: { value: FurnishDensity | undefined; onChange: (v: FurnishDensity | undefined) => void; allowDefault: boolean }) {
  return (
    <Field label="Density">
      <Select value={value ?? ''} onChange={(e) => onChange((e.target.value || undefined) as FurnishDensity | undefined)}>
        {allowDefault && <option value="">(use layout default)</option>}
        {FURNISH_DENSITIES.map((d) => (
          <option key={d} value={d}>
            {d}
          </option>
        ))}
      </Select>
    </Field>
  );
}

/** Layout meta: name, grid size, background, corridor width, seed (with a dice), style override. */
function LayoutMeta({
  draft,
  onMeta,
}: {
  draft: OfficeLayoutInput;
  onMeta: (patch: Partial<Pick<OfficeLayoutInput, 'name' | 'width' | 'height' | 'seed' | 'background' | 'corridorWidth' | 'style'>>) => void;
}) {
  const L = LAYOUT_LIMITS;
  return (
    <div className="space-y-2 border-b border-ink-700 p-2.5">
      <Field label="Name">
        <Input value={draft.name} onChange={(e) => onMeta({ name: e.target.value })} maxLength={L.maxNameLength} />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Width">
          <Input
            type="number"
            min={L.minWidth}
            max={L.maxWidth}
            value={draft.width}
            onChange={(e) => onMeta({ width: int(e.target.value, draft.width) })}
          />
        </Field>
        <Field label="Height">
          <Input
            type="number"
            min={L.minHeight}
            max={L.maxHeight}
            value={draft.height}
            onChange={(e) => onMeta({ height: int(e.target.value, draft.height) })}
          />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Background">
          <Select value={draft.background ?? 'hall'} onChange={(e) => onMeta({ background: e.target.value as 'hall' | 'void' })}>
            <option value="hall">Hall (open floor)</option>
            <option value="void">Void (carved corridors)</option>
          </Select>
        </Field>
        <Field label="Corridor width" hint="Only used with Void">
          <Input
            type="number"
            min={1}
            max={3}
            disabled={(draft.background ?? 'hall') !== 'void'}
            value={draft.corridorWidth ?? 2}
            onChange={(e) => onMeta({ corridorWidth: int(e.target.value, draft.corridorWidth ?? 2) })}
          />
        </Field>
      </div>
      <Field label="Seed">
        <div className="flex gap-1.5">
          <Input
            type="number"
            className="flex-1"
            min={0}
            max={0xffffffff}
            value={draft.seed}
            onChange={(e) => onMeta({ seed: int(e.target.value, draft.seed) })}
          />
          <Button title="Reroll the seed (furniture and corridor variation only — rooms stay put)" onClick={() => onMeta({ seed: Math.floor(Math.random() * 0xffffffff) })}>
            🎲
          </Button>
        </div>
      </Field>
      <Field label="Style override" hint="Blank uses the office's default style">
        <Select value={draft.style ?? ''} onChange={(e) => onMeta({ style: (e.target.value || undefined) as OfficeLayoutInput['style'] })}>
          <option value="">(office default)</option>
          {OFFICE_STYLES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
      </Field>
    </div>
  );
}

/** Layout-wide furnishing defaults (M8 8n): every room's `furnish` falls back to these, then to
 * built-ins. No `seats`/`seed` here — those only ever make sense per room. */
function FurnishDefaultsFields({
  defaults,
  onChange,
}: {
  defaults: OfficeLayoutInput['furnishDefaults'];
  onChange: (patch: Partial<NonNullable<OfficeLayoutInput['furnishDefaults']>>) => void;
}) {
  return (
    <div className="space-y-2 border-b border-ink-700 p-2.5">
      <div className="text-[10px] uppercase tracking-wide text-ink-400">Furnishing defaults</div>
      <DensityField value={defaults?.density} onChange={(density) => onChange({ density })} allowDefault={false} />
      <RangeField label={`Decoration ${pct(defaults?.decor, 0.3)}%`} value={pct(defaults?.decor, 0.3)} onChange={(decor) => onChange({ decor })} />
      <Field label="Aisle width">
        <Select value={defaults?.aisle ?? 1} onChange={(e) => onChange({ aisle: int(e.target.value, 1) })}>
          <option value={1}>1</option>
          <option value={2}>2</option>
          <option value={3}>3</option>
        </Select>
      </Field>
    </div>
  );
}

/** Per-room furnishing controls (M8 8n): density, seat/desk count (label adapts to the room type),
 * decoration amount, aisle width, re-roll (fresh `furnish.seed`) and reset (clears every override). */
function FurnishFields({
  room,
  layoutDefaults,
  onFurnish,
  onReroll,
  onReset,
}: {
  room: LayoutRoom;
  layoutDefaults: OfficeLayoutInput['furnishDefaults'];
  onFurnish: (patch: Partial<RoomFurnish>) => void;
  onReroll: () => void;
  onReset: () => void;
}) {
  const f = room.furnish;
  const hasOverrides = f !== undefined && Object.keys(f).length > 0;
  const defaultDecor = layoutDefaults?.decor ?? 0.3;
  const decorPct = pct(f?.decor, defaultDecor);
  return (
    <div className="space-y-2 border-t border-ink-700 p-2.5">
      <div className="text-[10px] uppercase tracking-wide text-ink-400">Furnishing</div>
      <DensityField value={f?.density} onChange={(density) => onFurnish({ density })} allowDefault />
      <Field label={seatLabel(room.type)} hint="Blank = auto for this room's size">
        <div className="flex items-center gap-1.5">
          <Button onClick={() => onFurnish({ seats: Math.max(0, (f?.seats ?? 0) - 1) })} aria-label={`Fewer ${seatLabel(room.type).toLowerCase()}`}>
            −
          </Button>
          <Input
            type="number"
            className="flex-1"
            min={0}
            max={LAYOUT_LIMITS.maxSeatsPerRoom}
            placeholder="auto"
            value={f?.seats ?? ''}
            onChange={(e) => onFurnish({ seats: e.target.value === '' ? undefined : int(e.target.value, 0) })}
          />
          <Button
            onClick={() => onFurnish({ seats: Math.min(LAYOUT_LIMITS.maxSeatsPerRoom, (f?.seats ?? 0) + 1) })}
            aria-label={`More ${seatLabel(room.type).toLowerCase()}`}
          >
            +
          </Button>
        </div>
      </Field>
      <RangeField label={`Decoration ${decorPct}%`} value={decorPct} onChange={(decor) => onFurnish({ decor })} />
      <Field label="Aisle width" hint="Blank uses the layout default">
        <Select value={f?.aisle ?? ''} onChange={(e) => onFurnish({ aisle: e.target.value === '' ? undefined : int(e.target.value, 1) })}>
          <option value="">(use layout default)</option>
          <option value={1}>1</option>
          <option value={2}>2</option>
          <option value={3}>3</option>
        </Select>
      </Field>
      <div className="flex gap-2">
        <Button className="flex-1" onClick={onReroll} title="Re-rolls this room's arrangement without changing the layout seed">
          🎲 Re-roll arrangement
        </Button>
        <Button variant="ghost" disabled={!hasOverrides} onClick={onReset}>
          Reset to defaults
        </Button>
      </div>
    </div>
  );
}

/** Door editing controls that don't need the canvas (M8 8n): "Auto doors" toggle and "Seal room". The
 * doors themselves are added/moved/resized/deleted with the Doors tool on the canvas. */
function DoorsFields({ room, onAutoDoors, onSeal }: { room: LayoutRoom; onAutoDoors: () => void; onSeal: () => void }) {
  const auto = room.doors === undefined;
  const sealed = room.doors?.length === 0;
  return (
    <div className="space-y-2 border-t border-ink-700 p-2.5">
      <div className="text-[10px] uppercase tracking-wide text-ink-400">Doors</div>
      <Checkbox checked={auto} onChange={() => onAutoDoors()} label="Auto doors (clears any manual edits)" />
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-ink-400">
          {sealed ? 'Sealed — nobody can reach this room.' : `${room.doors?.length ?? 'auto'} door(s)`}
        </span>
        <Button
          variant="danger"
          disabled={sealed}
          onClick={() => {
            if (window.confirm('Seal this room? It removes every door — nobody will be able to reach it until you add one back.')) onSeal();
          }}
          title="Removes every door — a warning lets you save anyway, but nothing can reach this room"
        >
          Seal room
        </Button>
      </div>
    </div>
  );
}

/** The selected room's fields: type, name, walled, exact x/y/w/h, plus (M8 8n) furnishing and doors. */
function RoomFields({
  room,
  furnishDefaults,
  onChange,
  onFurnish,
  onRerollFurnish,
  onResetFurnish,
  onAutoDoors,
  onSealRoom,
}: {
  room: LayoutRoom;
  furnishDefaults: OfficeLayoutInput['furnishDefaults'];
  onChange: (patch: Partial<Omit<LayoutRoom, 'id'>>) => void;
  onFurnish: (patch: Partial<RoomFurnish>) => void;
  onRerollFurnish: () => void;
  onResetFurnish: () => void;
  onAutoDoors: () => void;
  onSealRoom: () => void;
}) {
  const walled = isRoomWalled(room);
  const defaultWalled = DEFAULT_WALLED_ROOM_TYPES.includes(room.type);
  const furnishable = !UNFURNISHABLE.includes(room.type);
  return (
    <div>
      <div className="space-y-2 p-2.5">
        <div className="flex items-center justify-between text-[10px] uppercase tracking-wide text-ink-400">
          <span>Room</span>
          <span className="font-mono normal-case text-ink-500">{room.id}</span>
        </div>
        <Field label="Type">
          <Select value={room.type} onChange={(e) => onChange({ type: e.target.value as RoomType })}>
            {ROOM_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Display name" hint="Defaults to the style's room name">
          <Input value={room.name ?? ''} placeholder="(default)" onChange={(e) => onChange({ name: e.target.value || undefined })} />
        </Field>
        <Checkbox
          checked={walled}
          onChange={(v) => onChange({ walled: v === defaultWalled ? undefined : v })}
          label={`Walled${defaultWalled ? ' (default for this type)' : ''}`}
        />
        <div className="grid grid-cols-2 gap-2">
          <Field label="X">
            <Input type="number" min={0} value={room.x} onChange={(e) => onChange({ x: int(e.target.value, room.x) })} />
          </Field>
          <Field label="Y">
            <Input type="number" min={0} value={room.y} onChange={(e) => onChange({ y: int(e.target.value, room.y) })} />
          </Field>
          <Field label="Width">
            <Input type="number" min={1} value={room.w} onChange={(e) => onChange({ w: int(e.target.value, room.w) })} />
          </Field>
          <Field label="Height">
            <Input type="number" min={1} value={room.h} onChange={(e) => onChange({ h: int(e.target.value, room.h) })} />
          </Field>
        </div>
      </div>
      {furnishable && (
        <FurnishFields room={room} layoutDefaults={furnishDefaults} onFurnish={onFurnish} onReroll={onRerollFurnish} onReset={onResetFurnish} />
      )}
      {walled && <DoorsFields room={room} onAutoDoors={onAutoDoors} onSeal={onSealRoom} />}
    </div>
  );
}

export function Inspector({
  draft,
  theme,
  selectedRoom,
  onMeta,
  onFurnishDefaults,
  onRoomChange,
  onRoomFurnish,
  onRerollFurnish,
  onResetFurnish,
  onAutoDoors,
  onSealRoom,
}: {
  draft: OfficeLayoutInput;
  theme: ThemeDefinition;
  selectedRoom: LayoutRoom | undefined;
  onMeta: (patch: Partial<Pick<OfficeLayoutInput, 'name' | 'width' | 'height' | 'seed' | 'background' | 'corridorWidth' | 'style'>>) => void;
  onFurnishDefaults: (patch: Partial<NonNullable<OfficeLayoutInput['furnishDefaults']>>) => void;
  onRoomChange: (id: string, patch: Partial<Omit<LayoutRoom, 'id'>>) => void;
  onRoomFurnish: (id: string, patch: Partial<RoomFurnish>) => void;
  onRerollFurnish: (id: string) => void;
  onResetFurnish: (id: string) => void;
  onAutoDoors: (id: string) => void;
  onSealRoom: (id: string) => void;
}) {
  return (
    <aside className="flex w-72 shrink-0 flex-col overflow-y-auto border-l border-ink-700 bg-ink-850">
      <LayoutMeta draft={draft} onMeta={onMeta} />
      <FurnishDefaultsFields defaults={draft.furnishDefaults} onChange={onFurnishDefaults} />
      {selectedRoom ? (
        <RoomFields
          room={selectedRoom}
          furnishDefaults={draft.furnishDefaults}
          onChange={(patch) => onRoomChange(selectedRoom.id, patch)}
          onFurnish={(patch) => onRoomFurnish(selectedRoom.id, patch)}
          onRerollFurnish={() => onRerollFurnish(selectedRoom.id)}
          onResetFurnish={() => onResetFurnish(selectedRoom.id)}
          onAutoDoors={() => onAutoDoors(selectedRoom.id)}
          onSealRoom={() => onSealRoom(selectedRoom.id)}
        />
      ) : (
        <div className="p-2.5 text-[11px] text-ink-400">
          Select a room to edit it, or draw one with the Room tool ({theme.roomNames.desks}, {theme.roomNames.stairs}, …).
        </div>
      )}
    </aside>
  );
}
