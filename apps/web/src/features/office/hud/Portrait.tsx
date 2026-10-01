import { useEffect, useRef } from 'react';
import type { HeroAppearance, HeroLookStyle } from '@tagconn/shared';
import { paintPortrait } from '../../../game/heroPreview';
import { resolveCostume } from '../../../game/lookResolver';
import { getTheme } from '../../../game/themes';

export interface PortraitLook {
  appearance: HeroAppearance;
  role: string;
  roleColor: number;
  style: HeroLookStyle;
}

/** Frame sizes in bitmap px and where the feet sit in them (before `paintPortrait`'s bust shift). */
const FRAMES = {
  bust: { w: 22, h: 20, x: 11, y: 20 },
  full: { w: 24, h: 26, x: 12, y: 25 },
} as const;

/** A character portrait on a plain 2D canvas, drawn once per (look, crop, scale) from the same bitmaps the
 *  scene uses. No animation. `scale` is CSS px per bitmap px. */
export function Portrait({ look, crop = 'bust', scale = 2, className }: { look: PortraitLook; crop?: 'bust' | 'full'; scale?: number; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const f = FRAMES[crop];
  const key = JSON.stringify([look, crop, scale]);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!ctx || !canvas) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    paintPortrait(ctx, {
      appearance: look.appearance,
      themeCostume: resolveCostume(getTheme(look.style), look.role),
      roleColor: look.roleColor,
      scale,
      originX: f.x * scale,
      originY: f.y * scale,
      crop,
    });
    // `key` stands for every field of `look`, which is a fresh object each render.
  }, [key]);
  return <canvas ref={ref} width={f.w * scale} height={f.h * scale} aria-hidden="true" className={className} style={{ imageRendering: 'pixelated', width: f.w * scale, height: f.h * scale }} />;
}
