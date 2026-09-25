import { homedir } from 'node:os';
import { join } from 'node:path';

export type PlainObject = Record<string, unknown>;

export const isPlainObject = (v: unknown): v is PlainObject =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

/** Never merge/assign these: `out['__proto__'] = x` on an object literal mutates its prototype. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Deep-merges `patch` into a copy of `base`. Arrays and scalars replace; a `null` in the patch deletes
 * the key (i.e. reverts an override to the lower layer). Prototype-pollution keys are dropped.
 */
export function deepMerge(base: PlainObject, patch: PlainObject): PlainObject {
  const out: PlainObject = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (UNSAFE_KEYS.has(key) || value === undefined) continue;
    if (value === null) {
      delete out[key];
    } else if (isPlainObject(value)) {
      const prev = out[key];
      out[key] = deepMerge(isPlainObject(prev) ? prev : {}, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Like {@link deepMerge}, but a dotted path listed in `wholesalePaths` (map/record-typed settings,
 * e.g. agents.typeToRole, office.zones) is replaced wholesale instead of merged key-by-key, so a
 * patch can delete an entry by sending the full desired map.
 */
export function deepMergeReplacing(base: PlainObject, patch: PlainObject, wholesalePaths: readonly string[], prefix = ''): PlainObject {
  const out: PlainObject = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (UNSAFE_KEYS.has(key) || value === undefined) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    if (value === null) {
      delete out[key];
    } else if (wholesalePaths.includes(path)) {
      out[key] = value;
    } else if (isPlainObject(value)) {
      const prev = out[key];
      out[key] = deepMergeReplacing(isPlainObject(prev) ? prev : {}, value, wholesalePaths, path);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Dotted paths of every leaf in `obj` (used to check a patch against GUI_IMMUTABLE_SETTINGS). */
export function collectLeafPaths(obj: PlainObject, prefix = ''): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (UNSAFE_KEYS.has(key)) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(value)) out.push(...collectLeafPaths(value, path));
    else out.push(path);
  }
  return out;
}

/** Drops any subtree whose dotted path equals, or is nested under, one of `prefixes`. */
export function pruneByPrefixes(obj: PlainObject, prefixes: readonly string[], prefix = ''): PlainObject {
  const out: PlainObject = {};
  for (const [key, value] of Object.entries(obj)) {
    if (UNSAFE_KEYS.has(key)) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    if (prefixes.some((p) => path === p || path.startsWith(`${p}.`))) continue;
    if (isPlainObject(value)) {
      const pruned = pruneByPrefixes(value, prefixes, path);
      if (Object.keys(pruned).length > 0) out[key] = pruned;
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Dotted paths of leaves that differ between a and b (arrays compared as whole values). */
export function diffKeys(a: unknown, b: unknown, prefix = ''): string[] {
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].flatMap((k) => diffKeys(a[k], b[k], prefix ? `${prefix}.${k}` : k));
  }
  return JSON.stringify(a) === JSON.stringify(b) ? [] : [prefix];
}

/** Drops empty objects left behind after `null` deletions. */
export function pruneEmpty(obj: PlainObject): PlainObject {
  const out: PlainObject = {};
  for (const [k, v] of Object.entries(obj)) {
    if (isPlainObject(v)) {
      const pruned = pruneEmpty(v);
      if (Object.keys(pruned).length > 0) out[k] = pruned;
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function setPath(obj: PlainObject, path: string[], value: unknown): void {
  let cur = obj;
  path.forEach((key, i) => {
    if (i === path.length - 1) {
      cur[key] = value;
      return;
    }
    const next = cur[key];
    cur = cur[key] = isPlainObject(next) ? next : {};
  });
}

export function getPath(obj: unknown, path: string[]): unknown {
  let cur = obj;
  for (const key of path) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}
