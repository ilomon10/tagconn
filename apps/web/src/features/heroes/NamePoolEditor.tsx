import { useEffect, useState } from 'react';
import { HERO_DEFAULT_POOL_KEY, type HeroNamePools } from '@tagconn/shared';
import { parsePoolText, poolTextInSync, validateNamePools } from './namePools';
import { Field, Textarea } from '../../components/ui';

/**
 * The Heroes panel's "Name pools" tab (docs/design/living-office.md section 3.4): one textarea per
 * role (one name per line) plus `default`, with inline validation. The caller owns the draft and
 * saves it as `settings.heroes.namePools` — a wholesale-replace setting, so this component always
 * hands back the *whole* map, never a partial patch.
 */

/** Keeps the raw text while typing (so a trailing space or newline survives); the parsed names only
 *  flow out through `onNames`, and the text is re-synced from props only when they really differ. */
function PoolTextarea({ role, names, onNames, invalid }: { role: string; names: string[]; onNames: (names: string[]) => void; invalid: boolean }) {
  const [text, setText] = useState(names.join('\n'));
  useEffect(() => {
    if (!poolTextInSync(text, names)) setText(names.join('\n'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [names]);
  return (
    <Textarea
      rows={7}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onNames(parsePoolText(e.target.value));
      }}
      placeholder="One name per line"
      aria-invalid={invalid}
      aria-label={`Name pool for ${role}`}
    />
  );
}

export function NamePoolEditor({ pools, roles, onChange }: { pools: HeroNamePools; roles: string[]; onChange: (pools: HeroNamePools) => void }) {
  const issuesByRole = new Map<string, string[]>();
  for (const issue of validateNamePools(pools)) issuesByRole.set(issue.role, [...(issuesByRole.get(issue.role) ?? []), issue.message]);

  // An emptied textarea keeps `[]` here; `normalizePoolsForSave` drops it when saving.
  const setRole = (role: string, names: string[]) => onChange({ ...pools, [role]: names });

  return (
    <div className="grid grid-cols-1 gap-4 overflow-y-auto p-4 sm:grid-cols-2 xl:grid-cols-3">
      {roles.map((role) => {
        const issues = issuesByRole.get(role) ?? [];
        return (
          <Field key={role} label={role === HERO_DEFAULT_POOL_KEY ? 'default (fallback for other roles)' : role} hint={issues.join(' ') || undefined}>
            <PoolTextarea role={role} names={Object.hasOwn(pools, role) ? (pools[role] ?? []) : []} onNames={(n) => setRole(role, n)} invalid={issues.length > 0} />
          </Field>
        );
      })}
    </div>
  );
}
