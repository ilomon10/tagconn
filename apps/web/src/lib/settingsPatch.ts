import { GUI_IMMUTABLE_SETTINGS, MASKED_SECRET, RESTART_REQUIRED_SETTINGS, type Settings, type SettingsPatch } from '@tagconn/shared';

type Section = keyof Settings;
const sections = (s: Settings) => Object.keys(s) as Section[];
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Keys under these prefixes can only be set via config file / env; the server rejects them. */
export const isGuiImmutable = (dotted: string) =>
  (GUI_IMMUTABLE_SETTINGS as readonly string[]).some((p) => dotted === p || dotted.startsWith(`${p}.`));

/**
 * Minimal patch turning `base` into `draft`. Leaf keys (including arrays and records such as
 * `agents.typeToRole` or `office.zones`) are sent whole so removals are expressed too.
 */
export function diffSettings(base: Settings, draft: Settings): SettingsPatch {
  const patch: Record<string, Record<string, unknown>> = {};
  for (const section of sections(draft)) {
    const b = base[section] as Record<string, unknown>;
    const d = draft[section] as Record<string, unknown>;
    for (const k of Object.keys(d)) {
      if (same(b[k], d[k]) || isGuiImmutable(`${section}.${k}`) || d[k] === MASKED_SECRET) continue;
      (patch[section] ??= {})[k] = d[k];
    }
  }
  return patch as SettingsPatch;
}

/** Local application of a patch (demo mode) using the same leaf-replacement semantics. */
export function applySettingsPatch(base: Settings, patch: SettingsPatch): Settings {
  const out = structuredClone(base) as unknown as Record<string, Record<string, unknown>>;
  for (const [section, values] of Object.entries(patch as Record<string, Record<string, unknown> | undefined>)) {
    if (!values || !out[section]) continue;
    for (const [k, v] of Object.entries(values)) if (v !== undefined) out[section][k] = structuredClone(v);
  }
  return out as unknown as Settings;
}

/** Dotted keys present in the patch. */
export function patchKeys(patch: SettingsPatch): string[] {
  return Object.entries(patch as Record<string, Record<string, unknown> | undefined>).flatMap(([s, v]) =>
    v ? Object.keys(v).map((k) => `${s}.${k}`) : [],
  );
}

const restartSet: ReadonlySet<string> = new Set(RESTART_REQUIRED_SETTINGS);
export const isRestartRequired = (dotted: string) => restartSet.has(dotted);
export const restartKeysIn = (patch: SettingsPatch) => patchKeys(patch).filter(isRestartRequired);
