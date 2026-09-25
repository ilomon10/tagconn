import { useEffect, useRef } from 'react';
import type { HeroAppearance } from '@tagconn/shared';
import { resolveCostume } from '../../game/lookResolver';
import { paintHeroPreview } from '../../game/heroPreview';
import { getTheme } from '../../game/themes';

/**
 * The hero editor's live preview (docs/design/living-office.md section 3.4): "a live preview is
 * rendered at 6x in both styles side by side (guild and modern) ... a 2D canvas painter over the
 * same ASCII bitmaps (see W4), so it needs no Phaser." `paintHeroPreview`/`resolveCostume` do the
 * actual drawing (`game/heroPreview.ts`, `game/lookResolver.ts`); this component only owns the
 * canvas refs and re-paints them whenever the appearance, role or role colour changes.
 */

const SCALE = 6;
const FRAME_W = 40;
const FRAME_H = 46;

function Frame({ label, appearance, role, roleColor, style }: { label: string; appearance: HeroAppearance; role: string; roleColor: number; style: 'guild' | 'modern' }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!ctx || !canvas) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const theme = getTheme(style);
    paintHeroPreview(ctx, {
      appearance,
      themeCostume: resolveCostume(theme, role),
      roleColor,
      scale: SCALE,
      originX: (FRAME_W / 2) * SCALE,
      originY: (FRAME_H - 2) * SCALE,
    });
  }, [appearance, role, roleColor, style]);

  return (
    <figure className="flex flex-col items-center gap-1">
      <canvas ref={ref} width={FRAME_W * SCALE} height={FRAME_H * SCALE} className="rounded-md bg-ink-950" role="img" aria-label={`${label} style preview`} />
      <figcaption className="text-[10px] text-ink-400">{label}</figcaption>
    </figure>
  );
}

export function HeroPreview({ appearance, role, roleColor }: { appearance: HeroAppearance; role: string; roleColor: number }) {
  return (
    <div className="flex items-center justify-center gap-6 rounded-lg border border-ink-700 bg-ink-900 p-4">
      <Frame label="Guild" appearance={appearance} role={role} roleColor={roleColor} style="guild" />
      <Frame label="Modern" appearance={appearance} role={role} roleColor={roleColor} style="modern" />
    </div>
  );
}
