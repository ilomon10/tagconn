import { useEffect, useMemo, useState } from 'react';
import type { Agent } from '@tagconn/shared';
import { Button, cx } from '../../../components/ui';
import { useMediaQuery } from '../../../lib/useMediaQuery';
import { Portrait } from '../hud/Portrait';
import { usePortraitLook } from '../hud/usePortraitLook';
import type { AlertCopy } from './alertCopy';
import { typewriterDone, typewriterText } from './typewriter';
import type { AlertKind } from './types';

const CHARS_PER_SEC = 30;

/** Accent per kind: the frame, glow and icon plate. */
const ACCENT: Record<AlertKind, { ring: string; glow: string; plate: string }> = {
  ask: { ring: 'border-sky-300/80', glow: 'shadow-[0_0_24px_-6px_rgba(125,211,252,0.55)]', plate: 'bg-sky-400/20 text-sky-200' },
  failure: { ring: 'border-rose-300/80', glow: 'shadow-[0_0_24px_-6px_rgba(253,164,175,0.55)]', plate: 'bg-rose-400/20 text-rose-200' },
  done: { ring: 'border-cozy', glow: 'shadow-[0_0_24px_-6px_rgba(245,192,122,0.6)]', plate: 'bg-cozy/20 text-cozy' },
};

function Typewriter({ text, reduced }: { text: string; reduced: boolean }) {
  const [elapsed, setElapsed] = useState(0);
  const chars = useMemo(() => Array.from(text), [text]);
  const done = typewriterDone(chars, elapsed, CHARS_PER_SEC, reduced);
  useEffect(() => {
    if (done) return;
    const start = performance.now();
    const t = setInterval(() => setElapsed(performance.now() - start), 33);
    return () => clearInterval(t);
  }, [text, done]);
  return (
    <>
      {/* The full text is the accessible name; the typed prefix is decoration. */}
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">{typewriterText(chars, elapsed, CHARS_PER_SEC, reduced)}</span>
      {!done && <span aria-hidden="true" className="ml-0.5 inline-block h-3 w-1.5 translate-y-0.5 bg-ink-100/80" />}
    </>
  );
}

/**
 * One JRPG-style text box: double border in the alert's accent, the agent's portrait, a title and a
 * typewriter body. It slides in and fades on mount (transform/opacity transition, `motion-safe` only);
 * under reduced motion it appears at once with the full text. Never takes focus.
 */
export function AlertBox({ kind, agent, copy, onShowMe, onDismiss }: { kind: AlertKind; agent: Agent | undefined; copy: AlertCopy; onShowMe: () => void; onDismiss: () => void }) {
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)');
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, []);
  const a = ACCENT[kind];
  return (
    <div
      className={cx(
        'pointer-events-auto w-full min-w-0 rounded-lg bg-ink-950/95 p-[3px] backdrop-blur sm:w-80',
        a.glow,
        'motion-safe:transition-[transform,opacity] motion-safe:duration-200 motion-safe:ease-[cubic-bezier(0.23,1,0.32,1)]',
        shown ? 'translate-x-0 opacity-100' : 'opacity-0 motion-safe:translate-x-6',
      )}
    >
      {/* Outer line is the container's ring; the inner border is the second line of the double frame. */}
      <div className={cx('rounded-md border-2 bg-ink-900/95 p-2.5 ring-1 ring-inset ring-ink-600/70', a.ring)}>
        <div className="flex items-start gap-2.5">
          {agent && <PortraitSlot agent={agent} />}
          <div className="min-w-0 flex-1 space-y-1">
            <p className="flex items-center gap-1.5 text-xs font-semibold leading-5 text-ink-100">
              <span aria-hidden="true" className={cx('inline-flex size-5 shrink-0 items-center justify-center rounded text-[11px]', a.plate)}>
                {copy.icon}
              </span>
              <span className="min-w-0 break-words">{copy.title}</span>
            </p>
            {copy.body && (
              <p className="min-h-[2.5em] break-words font-pixel text-[11px] leading-snug text-ink-300">
                <Typewriter text={copy.body} reduced={reduced} />
              </p>
            )}
          </div>
        </div>
        <div className="mt-2 flex items-center justify-end gap-1.5">
          <Button variant="subtle" data-sfx="ui-select" onClick={onShowMe} aria-label={`Show me: ${copy.title}`}>
            Show me
          </Button>
          <Button variant="ghost" onClick={onDismiss} aria-label={`Dismiss: ${copy.title}`} title="Dismiss">
            ✕
          </Button>
        </div>
      </div>
    </div>
  );
}

function PortraitSlot({ agent }: { agent: Agent }) {
  const { look } = usePortraitLook(agent);
  return (
    <div className="shrink-0 rounded-md bg-ink-950 ring-1 ring-ink-600/80">
      <Portrait look={look} scale={3} className="rounded-md" />
    </div>
  );
}
