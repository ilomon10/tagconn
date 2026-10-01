import { useEffect, useRef } from 'react';
import type { HeroAppearance, HeroLookStyle } from '@tagconn/shared';
import { resolveCostume } from '../../game/lookResolver';
import { paintHeroPreview } from '../../game/heroPreview';
import { getTheme } from '../../game/themes';

/**
 * The hero editor's live preview (docs/design/living-office.md section 3.4): a 2D canvas painter over
 * the same ASCII bitmaps at 6x, so it needs no Phaser. It shows one style at a time (the editor's
 * selected tab, M12): the caller resolves the appearance with `heroLookForStyle`, this component
 * dresses it with that style's theme costume (rift reuses the guild costumes).
 */

const SCALE = 6;
const FRAME_W = 40;
const FRAME_H = 46;

const STYLE_LABELS: Record<HeroLookStyle, string> = { modern: 'Modern', guild: 'Guild', rift: 'Rift' };

export function HeroPreview({ appearance, role, roleColor, style }: { appearance: HeroAppearance; role: string; roleColor: number; style: HeroLookStyle }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!ctx || !canvas) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    paintHeroPreview(ctx, {
      appearance,
      themeCostume: resolveCostume(getTheme(style), role),
      roleColor,
      scale: SCALE,
      originX: (FRAME_W / 2) * SCALE,
      originY: (FRAME_H - 2) * SCALE,
    });
  }, [appearance, role, roleColor, style]);

  return (
    <figure className="flex flex-col items-center gap-1 rounded-lg border border-ink-700 bg-ink-900 p-4">
      <canvas ref={ref} width={FRAME_W * SCALE} height={FRAME_H * SCALE} className="rounded-md bg-ink-950" role="img" aria-label={`${STYLE_LABELS[style]} style preview`} />
      <figcaption className="text-[10px] text-ink-400">{STYLE_LABELS[style]}</figcaption>
    </figure>
  );
}
