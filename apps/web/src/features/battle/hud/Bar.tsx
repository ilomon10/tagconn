import { useEffect, useRef, useState } from 'react';
import { cx } from '../../../components/ui';

/** Green above half, amber above a fifth, red below. */
export function hpTone(value: number, max: number): 'ok' | 'warn' | 'low' {
  const f = max > 0 ? value / max : 0;
  return f > 0.5 ? 'ok' : f > 0.2 ? 'warn' : 'low';
}
const TONE = { ok: 'bg-emerald-400', warn: 'bg-amber-400', low: 'bg-rose-500' } as const;

/** Eases the displayed number toward `target` over `ms` (linear; a draining bar is constant motion). No tween when reduced. */
export function useTween(target: number, ms: number, reduced: boolean): number {
  const [shown, setShown] = useState(target);
  const from = useRef(target);
  const cur = useRef(target);
  useEffect(() => {
    if (reduced || ms <= 0 || cur.current === target) {
      cur.current = from.current = target;
      setShown(target);
      return;
    }
    from.current = cur.current;
    const t0 = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / ms);
      cur.current = from.current + (target - from.current) * p;
      setShown(cur.current);
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, ms, reduced]);
  return shown;
}

export interface BarProps {
  label: string; // "HP", "FOCUS"
  value: number; // the real value (aria + settles on it)
  max: number;
  kind: 'hp' | 'focus';
  /** Tween duration (the current event's durationMs * 0.6). */
  tweenMs?: number;
  reduced: boolean;
  showNumbers?: boolean;
  className?: string;
}

/** A labelled meter. The fill is a `scaleX` (compositor only); the number counts along with it. */
export function Bar({ label, value, max, kind, tweenMs = 0, reduced, showNumbers = false, className }: BarProps) {
  const shown = useTween(value, tweenMs, reduced);
  const frac = max > 0 ? Math.min(1, Math.max(0, shown / max)) : 0;
  const tone = kind === 'focus' ? 'bg-sky-400' : TONE[hpTone(shown, max)];
  return (
    <div className={cx('flex items-center gap-1.5', className)}>
      <span aria-hidden="true" className="w-7 shrink-0 text-[9px] font-bold leading-none tracking-wider text-cozy/90">{label}</span>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={`${value} of ${max}`}
        className="h-2 min-w-0 flex-1 overflow-hidden rounded-sm bg-ink-950 ring-1 ring-ink-600"
      >
        <div className={cx('h-full w-full origin-left transition-colors duration-300', tone)} style={{ transform: `scaleX(${frac})` }} />
      </div>
      {showNumbers && (
        <span aria-hidden="true" className="w-14 shrink-0 text-right font-pixel text-[10px] tabular-nums leading-none text-ink-200">
          {Math.round(shown)}/{max}
        </span>
      )}
    </div>
  );
}
