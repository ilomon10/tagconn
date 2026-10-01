import { useCallback } from 'react';
import { uiSound } from '../../lib/audio/uiSound';
import { useHeroPanelStore } from '../heroes/store';
import { useHeroStore } from '../../stores/heroStore';
import { BattleHud } from './hud/BattleHud';
import { dispatch, setBattleInsets, useFlowStore, type BattleGameHost } from './useBattleFlow';

/**
 * Hosts the DOM HUD (U1) over the battle scene (G2). Renders nothing while the flow is idle or still choosing; the HUD
 * mounts once the scene's entry transition has finished. `game` is accepted so the office view can pass its handle;
 * the scene is driven by `useBattleFlow`, not from here.
 */
export function BattleOverlay(_props: { game?: BattleGameHost | null }) {
  const state = useFlowStore((s) => s.state);
  const session = useFlowStore((s) => s.session);

  const onContinue = useCallback(() => dispatch({ t: 'close' }), []);
  const onOpenHero = useCallback((heroId: string) => {
    const hero = Object.hasOwn(useHeroStore.getState().heroes, heroId) ? useHeroStore.getState().heroes[heroId] : undefined;
    dispatch({ t: 'close' });
    if (hero) useHeroPanelStore.getState().openHeroEditor(hero);
  }, []);

  if (state.phase === 'starting') {
    return (
      <div className="pointer-events-none fixed inset-x-0 bottom-6 z-40 flex justify-center">
        <p role="status" className="rounded-md bg-ink-950/90 px-3 py-1.5 text-xs text-ink-200 shadow-lg">
          Gathering the party…
        </p>
      </div>
    );
  }

  if (state.phase === 'fighting' || state.phase === 'resolving' || state.phase === 'results' || state.phase === 'error') {
    if (session?.ready) {
      return (
        <div className="pointer-events-none fixed inset-0 z-40" data-battle-overlay>
          <BattleHud
            controller={session.controller}
            style={session.style}
            reduced={session.reduced}
            phase={state.phase}
            outcome={state.phase === 'results' ? state.outcome : null}
            error={state.phase === 'error' ? state.message : null}
            onContinue={onContinue}
            onOpenHero={onOpenHero}
            onInsets={setBattleInsets}
          />
        </div>
      );
    }
    if (state.phase === 'error') {
      // No scene (the battle could not start) or it is not up yet: a plain card.
      return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <section role="alertdialog" aria-modal="true" aria-label="Battle error" data-modal="battle-error" className="w-full max-w-sm rounded-lg border-2 border-rose-300/80 bg-ink-900 p-4 text-center shadow-xl">
            <p className="text-sm text-rose-100">{state.message}</p>
            <button
              type="button"
              autoFocus
              onClick={() => {
                uiSound('ui-confirm');
                onContinue();
              }}
              className="mt-3 rounded-md bg-ink-700 px-3 py-1 text-xs text-ink-100 hover:bg-ink-600"
            >
              Continue
            </button>
          </section>
        </div>
      );
    }
  }
  return null;
}
