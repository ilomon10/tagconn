import { DEFAULT_WALLED_ROOM_TYPES, LAYOUT_LIMITS, OFFICE_STYLES, ROOM_TYPES, isRoomWalled, type LayoutRoom, type OfficeLayoutInput, type RoomType } from '@tagconn/shared';
import type { ThemeDefinition } from '../../game/themes';
import { Button, Checkbox, Field, Input, Select } from '../../components/ui';

const int = (v: string, fallback: number) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
};

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

/** The selected room's fields: type, name, walled, and exact x/y/w/h. */
function RoomFields({ room, onChange }: { room: LayoutRoom; onChange: (patch: Partial<Omit<LayoutRoom, 'id'>>) => void }) {
  const walled = isRoomWalled(room);
  const defaultWalled = DEFAULT_WALLED_ROOM_TYPES.includes(room.type);
  return (
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
  );
}

export function Inspector({
  draft,
  theme,
  selectedRoom,
  onMeta,
  onRoomChange,
}: {
  draft: OfficeLayoutInput;
  theme: ThemeDefinition;
  selectedRoom: LayoutRoom | undefined;
  onMeta: (patch: Partial<Pick<OfficeLayoutInput, 'name' | 'width' | 'height' | 'seed' | 'background' | 'corridorWidth' | 'style'>>) => void;
  onRoomChange: (id: string, patch: Partial<Omit<LayoutRoom, 'id'>>) => void;
}) {
  return (
    <aside className="flex w-72 shrink-0 flex-col overflow-y-auto border-l border-ink-700 bg-ink-850">
      <LayoutMeta draft={draft} onMeta={onMeta} />
      {selectedRoom ? (
        <RoomFields room={selectedRoom} onChange={(patch) => onRoomChange(selectedRoom.id, patch)} />
      ) : (
        <div className="p-2.5 text-[11px] text-ink-400">
          Select a room to edit it, or draw one with the Room tool ({theme.roomNames.desks}, {theme.roomNames.stairs}, …).
        </div>
      )}
    </aside>
  );
}
