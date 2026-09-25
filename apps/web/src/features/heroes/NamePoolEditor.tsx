import { HERO_DEFAULT_POOL_KEY, type HeroNamePools } from '@tagconn/shared';
import { parsePoolText, poolText, validateNamePools } from './namePools';
import { Field, Textarea } from '../../components/ui';

/**
 * The Heroes panel's "Name pools" tab (docs/design/living-office.md section 3.4): one textarea per
 * role (one name per line) plus `default`, with inline validation. The caller owns the draft and
 * saves it as `settings.heroes.namePools` — a wholesale-replace setting, so this component always
 * hands back the *whole* map, never a partial patch.
 */
export function NamePoolEditor({ pools, roles, onChange }: { pools: HeroNamePools; roles: string[]; onChange: (pools: HeroNamePools) => void }) {
  const issuesByRole = new Map<string, string[]>();
  for (const issue of validateNamePools(pools)) issuesByRole.set(issue.role, [...(issuesByRole.get(issue.role) ?? []), issue.message]);

  const setRole = (role: string, text: string) => {
    const names = parsePoolText(text);
    const next = { ...pools };
    // An emptied textarea removes the role's own pool entirely (rather than storing `[]`), so
    // `namePoolFor` falls back to `default` again instead of yielding no names at all.
    if (names.length === 0) delete next[role];
    else next[role] = names;
    onChange(next);
  };

  return (
    <div className="grid grid-cols-2 gap-4 overflow-y-auto p-4 xl:grid-cols-3">
      {roles.map((role) => {
        const issues = issuesByRole.get(role) ?? [];
        return (
          <Field key={role} label={role === HERO_DEFAULT_POOL_KEY ? 'default (fallback for other roles)' : role} hint={issues.join(' ') || undefined}>
            <Textarea rows={7} value={poolText(pools, role)} onChange={(e) => setRole(role, e.target.value)} placeholder="One name per line" aria-invalid={issues.length > 0} aria-label={`Name pool for ${role}`} />
          </Field>
        );
      })}
    </div>
  );
}
