import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { cx } from '../../components/ui';
import { uiSound } from '../../lib/audio/uiSound';
import { useModalFocus } from '../../lib/useModalFocus';
import { Portrait, type PortraitLook } from '../office/hud/Portrait';
import { useHeroStore } from '../../stores/heroStore';
import { useOfficeStore } from '../../stores/officeStore';
import { useProgressStore } from '../../stores/progressStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { battleLabel } from './labels';
import { formatKoTimer, partyCandidates } from './party';
import type { EncounterOffer, PartyCandidate } from './types';
import { appearanceFor, dispatch, lookForKey, useFlowStore } from './useBattleFlow';

function useTicker(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/** Modal "who fights?" list (design 3.4). Renders only while the flow is `picking`. */
export function PartyPicker() {
  const offer = useFlowStore((s) => (s.state.phase === 'picking' ? s.state.offer : null));
  if (!offer) return null;
  return <Picker offer={offer} />;
}

function Picker({ offer }: { offer: EncounterOffer }) {
  const heroes = useHeroStore((s) => s.heroes);
  const agents = useOfficeStore((s) => s.agents);
  const progress = useProgressStore((s) => s.progress);
  const settings = useSettingsStore((s) => s.settings);
  const maxParty = settings.battle.maxParty;
  const style = offer.style;

  const [picked, setPicked] = useState<readonly string[]>([]);
  const hasKo = useMemo(() => Object.values(progress).some((p) => p.koUntil !== null && p.projectId === offer.projectId), [progress, offer.projectId]);
  const now = useTicker(hasKo);
  const candidates = useMemo(() => partyCandidates(heroes, agents, progress, settings, offer.projectId, now), [heroes, agents, progress, settings, offer.projectId, now]);
  const looks = useMemo(() => {
    const out = new Map<string, PortraitLook>();
    for (const c of candidates) {
      const l = lookForKey(c.key, style);
      if (l) out.set(c.key, { appearance: appearanceFor(l, c.key), role: l.role, roleColor: l.roleColor, style: l.style });
    }
    return out;
  }, [candidates, style]);

  const ref = useRef<HTMLDivElement>(null);
  const rows = useRef<(HTMLButtonElement | null)[]>([]);
  const cancel = () => {
    uiSound('ui-back');
    dispatch({ t: 'cancel' });
  };
  useModalFocus(true, ref, { trap: true, onEscape: cancel });

  // A pick that stopped being selectable (it got KO'd, or left) drops out of the party.
  const live = picked.filter((k) => candidates.some((c) => c.key === k && c.selectable));
  const byKey = new Map(candidates.map((c) => [c.key, c] as const));

  const toggle = (c: PartyCandidate) => {
    if (!c.selectable) return uiSound('ui-error');
    if (live.includes(c.key)) {
      uiSound('ui-toggle');
      return setPicked(live.filter((k) => k !== c.key));
    }
    if (live.length >= maxParty) return uiSound('ui-error');
    uiSound('ui-toggle');
    setPicked([...live, c.key]);
  };
  const start = () => {
    const party = live.flatMap((k) => byKey.get(k)?.ref ?? []);
    if (party.length === 0) return uiSound('ui-error');
    uiSound('ui-confirm');
    dispatch({ t: 'pick', party });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = rows.current.findIndex((r) => r === document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (candidates.length === 0) return;
      e.preventDefault();
      const next = e.key === 'ArrowDown' ? Math.min(candidates.length - 1, i + 1) : Math.max(0, i === -1 ? 0 : i - 1);
      if (next !== i) uiSound('ui-hover');
      rows.current[next]?.focus();
    } else if (e.key === 'Enter' && i !== -1) {
      e.preventDefault();
      start();
    }
  };

  const enemy = battleLabel(style, 'enemy', offer.kind);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" data-modal="battle-party" role="dialog" aria-modal="true" aria-label="Choose your party" onClick={cancel}>
      <div ref={ref} onKeyDown={onKeyDown} onClick={(e) => e.stopPropagation()} className="flex max-h-[min(36rem,calc(100dvh-2rem))] w-full max-w-md flex-col rounded-lg border-2 border-cozy/70 bg-ink-900 p-3 shadow-xl ring-1 ring-inset ring-ink-600/70">
        <h2 className="font-pixel text-base text-cozy">Choose your party</h2>
        <p className="mt-0.5 text-xs text-ink-300">
          Facing {enemy}. Pick 1 to {maxParty}; the first pick fights first.
        </p>
        <ul className="mt-2 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto" aria-label="Candidates">
          {candidates.length === 0 && <li className="px-1 py-3 text-center text-xs text-ink-400">Nobody is available for this battle.</li>}
          {candidates.map((c, i) => {
            const order = live.indexOf(c.key);
            const look = looks.get(c.key);
            return (
              <li key={c.key}>
                <button
                  type="button"
                  ref={(el) => void (rows.current[i] = el)}
                  role="checkbox"
                  aria-checked={order !== -1}
                  aria-disabled={!c.selectable}
                  onClick={() => toggle(c)}
                  className={cx(
                    'flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left text-xs transition coarse:min-h-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cozy',
                    order !== -1 ? 'border-cozy bg-ink-700' : 'border-ink-700 bg-ink-800 hover:bg-ink-700',
                    !c.selectable && 'opacity-50 grayscale',
                  )}
                >
                  <span className="grid size-5 shrink-0 place-items-center rounded-full bg-ink-950 font-pixel text-[10px] text-cozy" aria-hidden="true">
                    {order !== -1 ? order + 1 : ''}
                  </span>
                  {look && <Portrait look={look} scale={2} className="shrink-0 rounded" />}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-ink-100">{c.name}</span>
                    <span className="block truncate text-[11px] text-ink-300">
                      {battleLabel(style, 'class', c.classId)} · {c.temporary ? `Lv ~${c.level}` : `Lv ${c.level}`} · {c.maxHp} HP
                    </span>
                  </span>
                  {c.working && <span className="shrink-0 rounded bg-sky-900/60 px-1.5 py-0.5 text-[10px] text-sky-200">⚙ working</span>}
                  {c.koUntil !== null && (
                    <span className="shrink-0 rounded bg-rose-900/60 px-1.5 py-0.5 text-[10px] text-rose-200">💫 {formatKoTimer(c.koUntil, now)}</span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
        <div className="mt-3 flex items-center justify-between gap-2">
          <span className="text-[11px] text-ink-400" aria-live="polite">
            {live.length}/{maxParty} chosen
          </span>
          <span className="flex gap-2">
            <button type="button" onClick={cancel} className="rounded-md bg-ink-700 px-3 py-1 text-xs text-ink-100 hover:bg-ink-600 coarse:min-h-11">
              Cancel
            </button>
            <button type="button" onClick={start} disabled={live.length === 0} className="rounded-md bg-cozy px-3 py-1 text-xs font-semibold text-ink-950 hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40 coarse:min-h-11">
              Start battle
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}
