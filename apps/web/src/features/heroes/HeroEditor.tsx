import {
  HERO_ACCESSORIES,
  HERO_HAIR_COLORS,
  HERO_HAIR_STYLE_COUNT,
  HERO_HATS,
  HERO_PROPS,
  HERO_SKIN_TONES,
  type Hero,
  type HeroAccessory,
  type HeroHat,
  type HeroProp,
} from '@tagconn/shared';
import type { HeroDraft } from './formState';
import { validateHeroName, validateHeroTitle } from './formState';
import { HeroPreview } from './HeroPreview';
import { Button, Field, Input, Select, cx } from '../../components/ui';

const HAT_LABELS: Record<HeroHat, string> = {
  auto: 'Auto (theme)',
  none: 'None',
  wizard: 'Wizard hat',
  hood: 'Hood',
  crown: 'Crown',
  helm: 'Helm',
  'bard-cap': 'Bard cap',
  circlet: 'Circlet',
};
const PROP_LABELS: Record<HeroProp, string> = { auto: 'Auto (theme)', none: 'None', staff: 'Staff', wand: 'Wand', hammer: 'Hammer', quill: 'Quill', lute: 'Lute', shield: 'Shield' };
const ACCESSORY_LABELS: Record<HeroAccessory, string> = { auto: 'Auto (theme)', none: 'None', goggles: 'Goggles', cloak: 'Cloak' };

function SwatchRow({ colors, value, onChange, label }: { colors: readonly string[]; value: string; onChange: (v: string) => void; label: string }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={label}>
      {colors.map((c) => (
        <button
          key={c}
          type="button"
          aria-label={`${label} ${c}`}
          aria-pressed={value.toLowerCase() === c.toLowerCase()}
          onClick={() => onChange(c)}
          className={cx('size-6 shrink-0 rounded-full ring-2 ring-offset-1 ring-offset-ink-850', value.toLowerCase() === c.toLowerCase() ? 'ring-cozy' : 'ring-transparent')}
          style={{ backgroundColor: c }}
        />
      ))}
      <input
        type="color"
        aria-label={`Custom ${label}`}
        value={/^#[0-9a-fA-F]{6}$/.test(value) ? value : '#000000'}
        onChange={(e) => onChange(e.target.value)}
        className="size-6 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0"
      />
    </div>
  );
}

/** A `#hex | null` field where `null` means "auto" (the theme's/role's own colour). */
function NullableColorField({ label, colors, value, fallback, onChange }: { label: string; colors: readonly string[]; value: string | null; fallback: string; onChange: (v: string | null) => void }) {
  const isAuto = value === null;
  return (
    <div className="space-y-1.5">
      <label className="flex items-center gap-2 text-[11px] text-ink-300">
        <input type="checkbox" className="size-3.5 accent-[#f5c07a]" checked={isAuto} onChange={(e) => onChange(e.target.checked ? null : fallback)} />
        Auto {label}
      </label>
      {!isAuto && <SwatchRow colors={colors} value={value} onChange={onChange} label={label} />}
    </div>
  );
}

export interface HeroEditorProps {
  hero: Hero;
  draft: HeroDraft;
  onDraftChange: (next: HeroDraft) => void;
  /** Themed title for this hero's role — the title field's placeholder and the panel heading. */
  themedTitle: string;
  roleColorHex: string;
  roleColorNumber: number;
  dirty: boolean;
  busy: boolean;
  error?: string | null;
  onSave: () => void;
  onReset: () => void;
  onDelete: () => void;
  onRandomize: (includeCostume: boolean) => void;
  onRollName: () => void;
  /** False while the hero is bound to a live agent (docs/design/living-office.md section 3.4: "Delete
   *  ... disabled while on a quest, with a tooltip explaining why"). */
  canDelete: boolean;
}

/**
 * The hero editor's edit pane (docs/design/living-office.md section 3.4): name, title, and every
 * `HeroAppearance` field, with a live two-style preview. All fields are plain labelled form
 * controls, so the whole pane is keyboard-operable with no bespoke key handling beyond Ctrl/Cmd+S
 * (owned by `HeroPanel`, which also owns save/reset/delete/conflict handling and the draft state).
 */
export function HeroEditor({ hero, draft, onDraftChange, themedTitle, roleColorHex, roleColorNumber, dirty, busy, error, onSave, onReset, onDelete, onRandomize, onRollName, canDelete }: HeroEditorProps) {
  const nameError = validateHeroName(draft.name);
  const titleError = validateHeroTitle(draft.title);
  const canSave = dirty && !nameError && !titleError && !busy;
  const setAppearance = (patch: Partial<HeroDraft['appearance']>) => onDraftChange({ ...draft, appearance: { ...draft.appearance, ...patch } });

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto p-4">
      <HeroPreview appearance={draft.appearance} role={hero.role} roleColor={roleColorNumber} />

      <div className="mt-4 grid grid-cols-2 gap-4">
        <Field label="Name" hint={nameError ?? undefined}>
          <div className="flex gap-1.5">
            <Input value={draft.name} onChange={(e) => onDraftChange({ ...draft, name: e.target.value })} maxLength={60} aria-invalid={!!nameError} />
            <Button variant="ghost" onClick={onRollName} title="Roll the next unused pool name" aria-label="Roll a new name">
              🎲
            </Button>
          </div>
        </Field>
        <Field label="Title" hint={titleError ?? `Placeholder: ${themedTitle}`}>
          <Input value={draft.title} placeholder={themedTitle} onChange={(e) => onDraftChange({ ...draft, title: e.target.value })} maxLength={80} aria-invalid={!!titleError} />
        </Field>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-4">
        <Field label="Skin">
          <SwatchRow colors={HERO_SKIN_TONES} value={draft.appearance.skin} onChange={(skin) => setAppearance({ skin })} label="Skin" />
        </Field>
        <Field label="Hair style">
          <div className="flex items-center gap-2">
            <Button variant="ghost" aria-label="Previous hair style" onClick={() => setAppearance({ hairStyle: (draft.appearance.hairStyle - 1 + HERO_HAIR_STYLE_COUNT) % HERO_HAIR_STYLE_COUNT })}>
              ◀
            </Button>
            <span className="w-16 text-center text-xs text-ink-300">Style {draft.appearance.hairStyle + 1}</span>
            <Button variant="ghost" aria-label="Next hair style" onClick={() => setAppearance({ hairStyle: (draft.appearance.hairStyle + 1) % HERO_HAIR_STYLE_COUNT })}>
              ▶
            </Button>
          </div>
        </Field>
        <Field label="Hair colour">
          <SwatchRow colors={HERO_HAIR_COLORS} value={draft.appearance.hairColor} onChange={(hairColor) => setAppearance({ hairColor })} label="Hair colour" />
        </Field>
        <Field label="Outfit colour">
          <NullableColorField label="(role colour)" colors={HERO_HAIR_COLORS} value={draft.appearance.outfitColor} fallback={roleColorHex} onChange={(outfitColor) => setAppearance({ outfitColor })} />
        </Field>
        <Field label="Hat">
          <Select value={draft.appearance.hat} onChange={(e) => setAppearance({ hat: e.target.value as HeroHat })}>
            {HERO_HATS.map((h) => (
              <option key={h} value={h}>
                {HAT_LABELS[h]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Hat colour">
          <NullableColorField
            label="(outfit colour)"
            colors={HERO_HAIR_COLORS}
            value={draft.appearance.hatColor}
            fallback={draft.appearance.outfitColor ?? roleColorHex}
            onChange={(hatColor) => setAppearance({ hatColor })}
          />
        </Field>
        <Field label="Prop">
          <Select value={draft.appearance.prop} onChange={(e) => setAppearance({ prop: e.target.value as HeroProp })}>
            {HERO_PROPS.map((p) => (
              <option key={p} value={p}>
                {PROP_LABELS[p]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Accessory">
          <Select value={draft.appearance.accessory} onChange={(e) => setAppearance({ accessory: e.target.value as HeroAccessory })}>
            {HERO_ACCESSORIES.map((a) => (
              <option key={a} value={a}>
                {ACCESSORY_LABELS[a]}
              </option>
            ))}
          </Select>
        </Field>
        {draft.appearance.accessory === 'cloak' && (
          <Field label="Accessory colour">
            <NullableColorField label="(role colour)" colors={HERO_HAIR_COLORS} value={draft.appearance.accessoryColor} fallback={roleColorHex} onChange={(accessoryColor) => setAppearance({ accessoryColor })} />
          </Field>
        )}
      </div>

      {error && (
        <p className="mt-3 text-[11px] text-red-300" role="alert">
          {error}
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-ink-700 pt-3">
        <Button
          onClick={(e) => onRandomize(e.shiftKey)}
          title="Randomize skin/hair/outfit. Hold Shift to also reroll hat/prop/accessory."
        >
          🎲 Randomize
        </Button>
        <Button variant="subtle" disabled={busy} onClick={onReset} title="Regenerate the seeded name and appearance">
          Reset
        </Button>
        <Button variant="danger" disabled={busy || !canDelete} onClick={onDelete} title={canDelete ? 'Delete this hero' : 'Cannot delete while on a quest (bound to a live agent)'}>
          Delete
        </Button>
        <Button variant="primary" className="ml-auto" disabled={!canSave} onClick={onSave} title="Ctrl/Cmd+S">
          Save
        </Button>
      </div>
    </div>
  );
}
