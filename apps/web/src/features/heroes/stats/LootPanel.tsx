import { useState } from 'react';
import { LOOT_IDS, lootGrant, type HeroProgress, type LootId } from '@tagconn/shared';
import { Button, cx } from '../../../components/ui';
import { uiSound } from '../../../lib/audio/uiSound';
import type { BattleStyle } from '../../../game/battle/types';
import { battleLabel } from '../../battle/labels';
import { equipTitle } from '../../battle/commands';

const ICON = { hat: '🎩', prop: '🧹', title: '🏅' } as const;

/** The loot grid of the stats sheet (docs/design/battles.md 3.9): owned in colour, locked as "???" silhouettes; titles can be equipped. */
export function LootPanel({ heroId, progress, style, canEdit, onGuard }: { heroId: string; progress: Pick<HeroProgress, 'loot' | 'equippedTitle'>; style: BattleStyle; canEdit: boolean; onGuard: (fn: () => void) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setTitle = async (title: LootId | null) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await equipTitle(heroId, title);
      uiSound('ui-confirm');
    } catch (err) {
      uiSound('ui-error');
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const owned = LOOT_IDS.filter((id) => progress.loot.includes(id)).length;
  return (
    <section aria-label="Loot" className="rounded-lg bg-ink-850 p-3" data-testid="loot-panel">
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-ink-400">Loot</h3>
        <span className="font-mono text-[10px] text-ink-400">
          {owned} / {LOOT_IDS.length}
        </span>
      </div>
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        {LOOT_IDS.map((id) => {
          const has = progress.loot.includes(id);
          const kind = lootGrant(id).kind;
          const equipped = kind === 'title' && progress.equippedTitle === id;
          return (
            <li key={id} data-loot={id} data-owned={has} className={cx('flex flex-col gap-1 rounded-md p-2 text-center text-xs', has ? 'bg-ink-700 text-ink-100' : 'bg-ink-900 text-ink-500', equipped && 'ring-1 ring-cozy')}>
              <span className={cx('text-xl', !has && 'opacity-30 brightness-0')} aria-hidden="true">
                {ICON[kind]}
              </span>
              <span className="font-medium">{has ? battleLabel(style, 'loot', id) : '???'}</span>
              {has && kind !== 'title' && <span className="text-[10px] text-ink-400">{kind === 'hat' ? 'Hat' : 'Prop'}: pick it in Look</span>}
              {has && kind === 'title' && (
                <Button variant="subtle" disabled={busy || !canEdit} onClick={() => onGuard(() => void setTitle(equipped ? null : id))}>
                  {equipped ? 'Unequip' : 'Equip title'}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      {error && (
        <p className="mt-2 text-[11px] text-red-300" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
