import { STAT_IDS, type StatId, type Stats } from '@tagconn/shared';
import { cx } from '../../../components/ui';

const STAT_LABEL: Record<StatId, string> = {
  hp: 'HP',
  atk: 'ATK',
  def: 'DEF',
  spd: 'SPD',
  focus: 'FOCUS',
};
const STAT_HINT: Record<StatId, string> = {
  hp: 'Hit points: how much a hero can take',
  atk: 'Attack: damage dealt',
  def: 'Defense: damage resisted',
  spd: 'Speed: who moves first',
  focus: 'Focus: the pool that powers moves',
};

/** HP / ATK / DEF / SPD / FOCUS of the saved build, with the change a not-yet-saved skill plan would make. */
export function StatsTable({ current, planned }: { current: Stats; planned: Stats }) {
  return (
    <table className="w-full text-xs" aria-label="Stats">
      <tbody>
        {STAT_IDS.map((id) => {
          const delta = planned[id] - current[id];
          return (
            <tr key={id} className="border-b border-ink-800 last:border-0" title={STAT_HINT[id]}>
              <th scope="row" className="py-1 pr-3 text-left font-medium text-ink-300">
                {STAT_LABEL[id]}
              </th>
              <td className="py-1 text-right font-mono tabular-nums text-ink-100">{planned[id]}</td>
              <td className={cx('w-14 py-1 pl-2 text-right font-mono tabular-nums', delta > 0 ? 'text-emerald-400' : delta < 0 ? 'text-red-400' : 'text-transparent')}>
                {delta === 0 ? '·' : `${delta > 0 ? '+' : ''}${delta}`}
                {delta !== 0 && <span className="sr-only"> from the saved build</span>}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
