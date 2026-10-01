import { useEffect, useMemo, useRef, useState } from 'react';
import { sfxBus } from '../../../game/sfxBus';
import { cx } from '../../../components/ui';
import { typewriterDone, typewriterText } from '../../office/alerts/typewriter';
import type { TimelineItem } from '../../../game/battle/types';

export const LOG_CHARS_PER_SEC = 40;
/** A text blip every Nth typed character. */
export const BLIP_EVERY = 3;
const VISIBLE_LINES = 3;

/** Pure: how many `battle-text` blips the typed prefix grew by between two character counts. */
export function blipsBetween(prevCount: number, nextCount: number, every = BLIP_EVERY): number {
  return Math.max(0, Math.floor(nextCount / every) - Math.floor(prevCount / every));
}

/** Pure: which scrollback lines to draw and whether the last one is the one being typed. */
export function visibleLog(lines: readonly string[], currentText: string | null): { older: string[]; live: string | null } {
  const tail = lines.slice(-VISIBLE_LINES - 1);
  if (currentText && tail[tail.length - 1] === currentText) return { older: tail.slice(0, -1).slice(-VISIBLE_LINES + 1), live: currentText };
  return { older: tail.slice(-VISIBLE_LINES), live: null };
}

function Typed({ text, reduced }: { text: string; reduced: boolean }) {
  const chars = useMemo(() => Array.from(text), [text]);
  const [elapsed, setElapsed] = useState(0);
  const done = typewriterDone(chars, elapsed, LOG_CHARS_PER_SEC, reduced);
  const counted = useRef(0);
  useEffect(() => {
    counted.current = 0;
    setElapsed(0);
  }, [text]);
  useEffect(() => {
    if (done) return;
    const start = performance.now();
    const t = setInterval(() => setElapsed(performance.now() - start), 33);
    return () => clearInterval(t);
  }, [text, done]);
  const shown = typewriterText(chars, elapsed, LOG_CHARS_PER_SEC, reduced);
  const n = Array.from(shown).length;
  useEffect(() => {
    if (!reduced && blipsBetween(counted.current, n) > 0) sfxBus.emit({ id: 'battle-text' });
    counted.current = n;
  }, [n, reduced]);
  return (
    <>
      <span aria-hidden="true">{shown}</span>
      {!done && <span aria-hidden="true" className="ml-0.5 inline-block h-3 w-1.5 translate-y-0.5 bg-ink-100/80" />}
    </>
  );
}

/**
 * The battle text box. Sighted users read the last few lines with the newest typed out; screen readers get every line
 * from a polite live region (the typed prefix is hidden from them), so nothing is announced character by character.
 */
export function BattleLog({ lines, current, reduced, onSkip }: { lines: readonly string[]; current: TimelineItem | null; reduced: boolean; onSkip?: () => void }) {
  const { older, live } = visibleLog(lines, current?.text || null);
  return (
    <div className="relative flex min-h-0 flex-1 flex-col justify-end gap-0.5 overflow-hidden px-3 py-2 font-pixel text-[12px] leading-snug text-ink-100" onClick={onSkip}>
      <ul role="log" aria-label="Battle log" aria-live="polite" aria-relevant="additions" className="sr-only">
        {lines.slice(-50).map((l, i) => (
          <li key={`${lines.length - Math.min(50, lines.length) + i}`}>{l}</li>
        ))}
      </ul>
      {older.map((l, i) => (
        <p key={`${lines.length}-${i}`} aria-hidden="true" className={cx('break-words', !live && i === older.length - 1 ? 'text-ink-50' : 'text-ink-400', i === 0 && older.length > 2 && 'opacity-60')}>
          {l}
        </p>
      ))}
      {live ? (
        <p aria-hidden="true" className="break-words text-ink-50">
          <Typed key={current?.seq} text={live} reduced={reduced} />
        </p>
      ) : null}
    </div>
  );
}
