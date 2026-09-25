import type { Agent } from '@tagconn/shared';
import { heroStatus, type HeroRoleGroup } from './formState';
import { Button, Dot, Select, cx } from '../../components/ui';

/**
 * The Heroes panel's roster (docs/design/living-office.md section 3.4): heroes grouped by role in
 * themed role-title order, each row a 32px-equivalent status line (name, "customized" dot, status),
 * plus "+ Recruit" to create a hero for a chosen role. Grouping and status are computed by the pure
 * helpers in `formState.ts` so this component stays presentational.
 */
export function HeroList({
  groups,
  agents,
  selectedId,
  onSelect,
  roleColor,
  recruitRoles,
  recruitRole,
  onRecruitRoleChange,
  onRecruit,
  recruitBusy,
  recruitError,
}: {
  groups: HeroRoleGroup[];
  agents: Record<string, Pick<Agent, 'description'>>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  roleColor: (role: string) => string;
  recruitRoles: string[];
  recruitRole: string;
  onRecruitRoleChange: (role: string) => void;
  onRecruit: () => void;
  recruitBusy: boolean;
  recruitError?: string | null;
}) {
  return (
    <div className="flex h-full w-72 shrink-0 flex-col border-r border-ink-700">
      <div className="flex items-center gap-1.5 border-b border-ink-700 p-2">
        <Select aria-label="Role to recruit" className="flex-1" value={recruitRole} onChange={(e) => onRecruitRoleChange(e.target.value)} disabled={recruitRoles.length === 0}>
          {recruitRoles.length === 0 && <option value="">(no roles)</option>}
          {recruitRoles.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </Select>
        <Button variant="primary" onClick={onRecruit} disabled={recruitBusy || recruitRoles.length === 0} title="Recruit a new hero for the selected role">
          + Recruit
        </Button>
      </div>
      {recruitError && (
        <p className="px-2 pt-1.5 text-[11px] text-red-300" role="alert">
          {recruitError}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {groups.length === 0 && <p className="p-3 text-xs text-ink-400">No heroes on this floor yet — recruit one above.</p>}
        {groups.map((g) => (
          <div key={g.role} className="mb-3">
            <h3 className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-wide text-ink-400">{g.title}</h3>
            <ul className="space-y-1">
              {g.heroes.map((h) => {
                const status = heroStatus(h, agents);
                const statusText =
                  status.kind === 'on-quest' ? `On quest${status.description ? ` · ${status.description}` : ''}` : status.kind === 'resting' ? 'Resting' : 'Away';
                return (
                  <li key={h.id}>
                    <button
                      type="button"
                      aria-pressed={selectedId === h.id}
                      onClick={() => onSelect(h.id)}
                      className={cx(
                        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition',
                        selectedId === h.id ? 'bg-ink-700' : 'hover:bg-ink-800',
                      )}
                    >
                      <Dot color={roleColor(h.role)} />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1 truncate text-xs font-medium text-ink-100">
                          <span className="truncate">{h.name}</span>
                          {h.customized && (
                            <span aria-label="Customized" title="Customized" className="text-cozy">
                              ●
                            </span>
                          )}
                        </span>
                        <span className="block truncate text-[10px] text-ink-400">{statusText}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
