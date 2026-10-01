import {
  HERO_ACCESSORIES,
  HERO_HAIR_COLORS,
  HERO_HAIR_STYLE_COUNT,
  HERO_HATS,
  HERO_LOOK_STYLES,
  HERO_PROPS,
  HERO_SKIN_TONES,
  isHeroReleased,
  type Hero,
  type HeroAccessory,
  type HeroAppearance,
  type HeroHat,
  type HeroLookStyle,
  type HeroProp,
  type LootHat,
  type LootProp,
  type HeroStyleOverride,
  type OfficeStyle,
} from '@tagconn/shared';
import { useState, type KeyboardEvent, type ReactNode } from 'react';
import { draftLookForStyle, validateHeroName, validateHeroTitle, withStyleOverride, type HeroDraft } from './formState';
import { HeroPreview } from './HeroPreview';
import { HeroStatsSheet } from './stats/HeroStatsSheet';
import { battleLabel } from '../battle/labels';
import { battleStyleOf, ownedLoot } from '../battle/lootTitle';
import { useHeroProgress } from '../battle/useProgress';
import { titleFor } from '../../game/lookResolver';
import { getTheme } from '../../game/themes';
import { hexToNumber } from '../../game/textures';
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

/** One appearance field; on a style tab (`useBase` not null) it gets a "Use base" toggle and is disabled while on. */
function AppField({ label, useBase, onUseBase, children }: { label: string; useBase: boolean | null; onUseBase: (on: boolean) => void; children: ReactNode }) {
  return (
    <Field label={label}>
      {useBase !== null && (
        <label className="mb-1 flex items-center gap-2 text-[11px] text-ink-300">
          <input type="checkbox" className="size-3.5 accent-[#f5c07a]" checked={useBase} onChange={(e) => onUseBase(e.target.checked)} />
          Use base
        </label>
      )}
      <fieldset disabled={useBase === true} className={cx('m-0 min-w-0 border-0 p-0', useBase && 'opacity-50')}>
        {children}
      </fieldset>
    </Field>
  );
}

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

type EditorTab = 'base' | HeroLookStyle;
const TABS: readonly { id: EditorTab; label: string }[] = [
  { id: 'base', label: 'Base' },
  ...HERO_LOOK_STYLES.map((id) => ({ id, label: id.charAt(0).toUpperCase() + id.slice(1) })),
];

type EditorSection = 'look' | 'stats';
const SECTIONS: readonly { id: EditorSection; label: string }[] = [
  { id: 'look', label: 'Look' },
  { id: 'stats', label: 'Stats & Skills' },
];

export interface HeroEditorProps {
  hero: Hero;
  draft: HeroDraft;
  onDraftChange: (next: HeroDraft) => void;
  /** Role colour and (un-themed) title, for any role (the draft's role can differ from the hero's). */
  roleInfo: (role: string) => { color: string; title: string };
  /** The floor's current office style: the Base tab's preview and title placeholder use its theme. */
  officeStyle: OfficeStyle;
  /** Roles the hero may move to (enabled roles plus its own current one). */
  roleOptions: string[];
  dirty: boolean;
  busy: boolean;
  error?: string | null;
  onSave: () => void;
  onReset: () => void;
  onDelete: () => void;
  onRandomize: (includeCostume: boolean) => void;
  onRollName: () => void;
  /** Below `md` the roster is hidden while a hero is open; this goes back to it. */
  onBack?: () => void;
  /** False while the hero is bound to a live agent (docs/design/living-office.md section 3.4: "Delete
   *  ... disabled while on a quest, with a tooltip explaining why"). */
  canDelete: boolean;
}

/**
 * The hero editor's edit pane (docs/design/living-office.md section 3.4): role, name, title, and every
 * `HeroAppearance` field, with a live preview. M12 adds per-style tabs (Base, Modern, Guild, Rift):
 * a style tab edits only that style's overrides, each field either "Use base" or an explicit value.
 * Fields are plain labelled controls; the tab strip is a roving-tabindex tablist (arrow keys). Ctrl/Cmd+S
 * is owned by `HeroPanel`, which also owns save/reset/delete/conflict handling and the draft state.
 */
export function HeroEditor({ hero, draft, onDraftChange, roleInfo, officeStyle, roleOptions, dirty, busy, error, onSave, onReset, onDelete, onRandomize, onRollName, onBack, canDelete }: HeroEditorProps) {
  const [section, setSection] = useState<EditorSection>('look');
  const [tab, setTab] = useState<EditorTab>('base');
  const style: HeroLookStyle | null = tab === 'base' ? null : tab;
  const override: HeroStyleOverride = style ? (draft.styles[style] ?? {}) : {};

  const bound = !isHeroReleased(hero);
  const role = roleInfo(draft.role);
  const roleColorHex = role.color;
  const previewStyle: HeroLookStyle = style ?? officeStyle;
  const placeholderTitle = titleFor(getTheme(previewStyle), draft.role, role.title);
  const look = style ? draftLookForStyle(draft, style).appearance : draft.appearance;
  // M14: loot hats/props are listed only when owned (the current pick stays listed so the select never goes blank).
  const progress = useHeroProgress(hero.id);
  const lootStyle = battleStyleOf(previewStyle);
  const lootHats = ownedLoot(progress, 'hat');
  const lootProps = ownedLoot(progress, 'prop');
  if (look.lootHat && !lootHats.includes(look.lootHat)) lootHats.push(look.lootHat);
  if (look.lootProp && !lootProps.includes(look.lootProp)) lootProps.push(look.lootProp);

  const nameError = validateHeroName(draft.name);
  const titleError = validateHeroTitle(draft.title);
  const styleTitleErrors = HERO_LOOK_STYLES.map((s) => {
    const t = draft.styles[s]?.title;
    return typeof t === 'string' ? validateHeroTitle(t) : null;
  });
  const styleTitleError = style ? styleTitleErrors[HERO_LOOK_STYLES.indexOf(style)] : null;
  const canSave = dirty && !nameError && !titleError && !styleTitleErrors.some(Boolean) && !busy;

  const setOverride = (next: HeroStyleOverride) => style && onDraftChange({ ...draft, styles: withStyleOverride(draft.styles, style, next) });
  const setAppearance = (patch: Partial<HeroAppearance>) => (style ? setOverride({ ...override, ...patch }) : onDraftChange({ ...draft, appearance: { ...draft.appearance, ...patch } }));
  const unsetField = (key: keyof HeroStyleOverride) => {
    const { [key]: _drop, ...rest } = override;
    setOverride(rest);
  };

  /** Props of the "Use base" toggle for appearance field `k` (null on the Base tab). */
  const baseToggle = (k: keyof HeroAppearance) => {
    // The hat and prop travel with their loot twin so "Use base" never leaves a stray loot override.
    const keys: (keyof HeroAppearance)[] = k === 'hat' ? ['hat', 'lootHat'] : k === 'prop' ? ['prop', 'lootProp'] : [k];
    return {
      useBase: style === null ? null : override[k] === undefined,
      onUseBase: (on: boolean) => {
        if (on) {
          const rest: Record<string, unknown> = { ...override };
          for (const key of keys) delete rest[key];
          setOverride(rest as HeroStyleOverride);
        } else {
          setOverride({ ...override, ...Object.fromEntries(keys.map((key) => [key, draft.appearance[key] ?? null])) });
        }
      },
    };
  };

  const onTabKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const i = TABS.findIndex((t) => t.id === tab);
    const next = e.key === 'ArrowRight' ? (i + 1) % TABS.length : e.key === 'ArrowLeft' ? (i - 1 + TABS.length) % TABS.length : e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    setTab(TABS[next]!.id);
    document.getElementById(`hero-tab-${TABS[next]!.id}`)?.focus();
  };

  const onSectionKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const i = SECTIONS.findIndex((t) => t.id === section);
    const next =
      e.key === 'ArrowRight' ? (i + 1) % SECTIONS.length : e.key === 'ArrowLeft' ? (i - 1 + SECTIONS.length) % SECTIONS.length : e.key === 'Home' ? 0 : e.key === 'End' ? SECTIONS.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    setSection(SECTIONS[next]!.id);
    document.getElementById(`hero-section-${SECTIONS[next]!.id}`)?.focus();
  };

  const roleSelectOptions = roleOptions.includes(draft.role) ? roleOptions : [...roleOptions, draft.role];

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto p-4">
      {onBack && (
        <Button variant="ghost" className="mb-3 self-start md:hidden" onClick={onBack}>
          ← Heroes
        </Button>
      )}
      <div className="flex justify-center">
        <HeroPreview appearance={look} role={draft.role} roleColor={hexToNumber(roleColorHex)} style={previewStyle} />
      </div>

      <div role="tablist" aria-label="Hero sheet" className="mt-4 flex gap-0.5 self-start rounded-lg bg-ink-850 p-0.5">
        {SECTIONS.map((t) => (
          <button
            key={t.id}
            id={`hero-section-${t.id}`}
            type="button"
            role="tab"
            aria-selected={section === t.id}
            aria-controls={`hero-section-panel-${t.id}`}
            tabIndex={section === t.id ? 0 : -1}
            onClick={() => setSection(t.id)}
            onKeyDown={onSectionKeyDown}
            className={cx('rounded-md px-3 py-1 text-xs', section === t.id ? 'bg-ink-600 text-ink-100' : 'text-ink-400 hover:text-ink-100')}
          >
            {t.label}
          </button>
        ))}
      </div>

      {section === 'stats' && (
        <div id="hero-section-panel-stats" role="tabpanel" aria-labelledby="hero-section-stats">
          <HeroStatsSheet hero={hero} />
        </div>
      )}

      <div id="hero-section-panel-look" role="tabpanel" aria-labelledby="hero-section-look" hidden={section !== 'look'} className={cx(section !== 'look' && 'hidden')}>
        <div role="tablist" aria-label="Look style" className="mt-4 flex gap-0.5 self-start rounded-lg bg-ink-850 p-0.5">
          {TABS.map((t) => (
            <button
              key={t.id}
              id={`hero-tab-${t.id}`}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              aria-controls="hero-tabpanel"
              tabIndex={tab === t.id ? 0 : -1}
              onClick={() => setTab(t.id)}
              onKeyDown={onTabKeyDown}
              className={cx('rounded-md px-3 py-1 text-xs', tab === t.id ? 'bg-ink-600 text-ink-100' : 'text-ink-400 hover:text-ink-100')}
            >
              {t.label}
              {t.id !== 'base' && draft.styles[t.id] && (
                <span aria-label="has overrides" className="ml-1 text-cozy">
                  ●
                </span>
              )}
            </button>
          ))}
        </div>

        <div id="hero-tabpanel" role="tabpanel" aria-labelledby={`hero-tab-${tab}`}>
          {style === null ? (
            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Role" hint={bound ? 'Release this hero to change its role' : undefined}>
                <Select aria-label="Role" value={draft.role} disabled={bound || busy} onChange={(e) => onDraftChange({ ...draft, role: e.target.value })}>
                  {roleSelectOptions.map((r) => (
                    <option key={r} value={r}>
                      {r}
                      {r === hero.role && !roleOptions.includes(r) ? ' (disabled role)' : ''}
                    </option>
                  ))}
                </Select>
              </Field>
              <div />
              <Field label="Name" hint={nameError ?? undefined}>
                <div className="flex gap-1.5">
                  <Input value={draft.name} onChange={(e) => onDraftChange({ ...draft, name: e.target.value })} maxLength={60} aria-invalid={!!nameError} />
                  <Button variant="ghost" onClick={onRollName} title="Roll the next unused pool name" aria-label="Roll a new name">
                    🎲
                  </Button>
                </div>
              </Field>
              <Field label="Title" hint={titleError ?? `Placeholder: ${placeholderTitle}`}>
                <Input value={draft.title} placeholder={placeholderTitle} onChange={(e) => onDraftChange({ ...draft, title: e.target.value })} maxLength={80} aria-invalid={!!titleError} />
              </Field>
            </div>
          ) : (
            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Title" hint={styleTitleError ?? (override.title === undefined ? undefined : `Placeholder: ${placeholderTitle}`)}>
                <label className="mb-1 flex items-center gap-2 text-[11px] text-ink-300">
                  <input
                    type="checkbox"
                    className="size-3.5 accent-[#f5c07a]"
                    checked={override.title === undefined}
                    onChange={(e) => (e.target.checked ? unsetField('title') : setOverride({ ...override, title: draft.title.trim() === '' ? null : draft.title.trim() }))}
                  />
                  Use base
                </label>
                <Input
                  value={override.title ?? ''}
                  placeholder={placeholderTitle}
                  disabled={override.title === undefined}
                  maxLength={80}
                  aria-label={`${TABS.find((t) => t.id === tab)?.label} title`}
                  aria-invalid={!!styleTitleError}
                  onChange={(e) => setOverride({ ...override, title: e.target.value })}
                />
              </Field>
              <div className="flex items-end">
                <Button
                  variant="subtle"
                  disabled={busy || !draft.styles[style]}
                  onClick={() => onDraftChange({ ...draft, styles: withStyleOverride(draft.styles, style, undefined) })}
                  title="Remove every override of this style (applied on Save)"
                >
                  Clear style overrides
                </Button>
              </div>
            </div>
          )}

          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <AppField label="Skin" {...baseToggle('skin')}>
              <SwatchRow colors={HERO_SKIN_TONES} value={look.skin} onChange={(skin) => setAppearance({ skin })} label="Skin" />
            </AppField>
            <AppField label="Hair style" {...baseToggle('hairStyle')}>
              <div className="flex items-center gap-2">
                <Button variant="ghost" aria-label="Previous hair style" onClick={() => setAppearance({ hairStyle: (look.hairStyle - 1 + HERO_HAIR_STYLE_COUNT) % HERO_HAIR_STYLE_COUNT })}>
                  ◀
                </Button>
                <span className="w-16 text-center text-xs text-ink-300">Style {look.hairStyle + 1}</span>
                <Button variant="ghost" aria-label="Next hair style" onClick={() => setAppearance({ hairStyle: (look.hairStyle + 1) % HERO_HAIR_STYLE_COUNT })}>
                  ▶
                </Button>
              </div>
            </AppField>
            <AppField label="Hair colour" {...baseToggle('hairColor')}>
              <SwatchRow colors={HERO_HAIR_COLORS} value={look.hairColor} onChange={(hairColor) => setAppearance({ hairColor })} label="Hair colour" />
            </AppField>
            <AppField label="Outfit colour" {...baseToggle('outfitColor')}>
              <NullableColorField label="(role colour)" colors={HERO_HAIR_COLORS} value={look.outfitColor} fallback={roleColorHex} onChange={(outfitColor) => setAppearance({ outfitColor })} />
            </AppField>
            <AppField label="Hat" {...baseToggle('hat')}>
              <Select
                aria-label="Hat"
                value={look.lootHat ? `loot:${look.lootHat}` : look.hat}
                onChange={(e) => {
                  const v = e.target.value;
                  setAppearance(v.startsWith('loot:') ? { lootHat: v.slice(5) as LootHat } : { hat: v as HeroHat, lootHat: null });
                }}
              >
                {HERO_HATS.map((h) => (
                  <option key={h} value={h}>
                    {HAT_LABELS[h]}
                  </option>
                ))}
                {lootHats.length > 0 && (
                  <optgroup label="Unlocked">
                    {lootHats.map((h) => (
                      <option key={h} value={`loot:${h}`}>
                        {battleLabel(lootStyle, 'loot', `hat-${h}`)}
                      </option>
                    ))}
                  </optgroup>
                )}
              </Select>
            </AppField>
            <AppField label="Hat colour" {...baseToggle('hatColor')}>
              <NullableColorField
                label="(outfit colour)"
                colors={HERO_HAIR_COLORS}
                value={look.hatColor}
                fallback={look.outfitColor ?? roleColorHex}
                onChange={(hatColor) => setAppearance({ hatColor })}
              />
            </AppField>
            <AppField label="Prop" {...baseToggle('prop')}>
              <Select
                aria-label="Prop"
                value={look.lootProp ? `loot:${look.lootProp}` : look.prop}
                onChange={(e) => {
                  const v = e.target.value;
                  setAppearance(v.startsWith('loot:') ? { lootProp: v.slice(5) as LootProp } : { prop: v as HeroProp, lootProp: null });
                }}
              >
                {HERO_PROPS.map((p) => (
                  <option key={p} value={p}>
                    {PROP_LABELS[p]}
                  </option>
                ))}
                {lootProps.length > 0 && (
                  <optgroup label="Unlocked">
                    {lootProps.map((p) => (
                      <option key={p} value={`loot:${p}`}>
                        {battleLabel(lootStyle, 'loot', `prop-${p}`)}
                      </option>
                    ))}
                  </optgroup>
                )}
              </Select>
            </AppField>
            <AppField label="Accessory" {...baseToggle('accessory')}>
              <Select aria-label="Accessory" value={look.accessory} onChange={(e) => setAppearance({ accessory: e.target.value as HeroAccessory })}>
                {HERO_ACCESSORIES.map((a) => (
                  <option key={a} value={a}>
                    {ACCESSORY_LABELS[a]}
                  </option>
                ))}
              </Select>
            </AppField>
            {(look.accessory === 'cloak' || (style !== null && override.accessoryColor !== undefined)) && (
              <AppField label="Accessory colour" {...baseToggle('accessoryColor')}>
                <NullableColorField
                  label="(role colour)"
                  colors={HERO_HAIR_COLORS}
                  value={look.accessoryColor}
                  fallback={roleColorHex}
                  onChange={(accessoryColor) => setAppearance({ accessoryColor })}
                />
              </AppField>
            )}
          </div>
        </div>

        {error && (
          <p className="mt-3 text-[11px] text-red-300" role="alert">
            {error}
          </p>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-ink-700 pt-3">
          <Button onClick={(e) => onRandomize(e.shiftKey)} title="Randomize the base skin/hair. Hold Shift to also reroll hat/prop/accessory.">
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
    </div>
  );
}
