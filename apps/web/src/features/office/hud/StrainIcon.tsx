import { useEffect, useRef } from 'react';
import { STRAIN_ICON } from '../../../game/drama';
import { CHARACTER_BITMAPS } from '../../../game/textures';
import type { StrainKind } from '../../../game/themes/types';

const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;

/** The strain emote's pixel icon (the same bitmap the scene shows over the character), 1 bitmap px = `scale` CSS px,
 *  with its auto-outline. Decorative: the words sit next to it. */
export function StrainIcon({ kind, scale = 2 }: { kind: StrainKind; scale?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const bitmap = CHARACTER_BITMAPS[STRAIN_ICON[kind]];
  const rows = bitmap?.rows ?? [];
  const w = rows.reduce((m, r) => Math.max(m, r.length), 0) + 2;
  const h = rows.length + 2;
  useEffect(() => {
    const ctx = ref.current?.getContext('2d');
    if (!ctx || !bitmap) return;
    ctx.clearRect(0, 0, w * scale, h * scale);
    const filled = (x: number, y: number) => (rows[y]?.[x] ?? ' ') !== ' ';
    if (bitmap.outline !== undefined) {
      ctx.fillStyle = hex(bitmap.outline);
      for (let y = -1; y <= rows.length; y++)
        for (let x = -1; x <= w - 2; x++)
          if (!filled(x, y) && (filled(x - 1, y) || filled(x + 1, y) || filled(x, y - 1) || filled(x, y + 1))) ctx.fillRect((x + 1) * scale, (y + 1) * scale, scale, scale);
    }
    rows.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        const c = bitmap.palette[row[x]!];
        if (row[x] === ' ' || c === undefined) continue;
        ctx.fillStyle = hex(c);
        ctx.fillRect((x + 1) * scale, (y + 1) * scale, scale, scale);
      }
    });
  }, [bitmap, rows, w, h, scale]);
  if (!bitmap) return null;
  return <canvas ref={ref} width={w * scale} height={h * scale} aria-hidden="true" style={{ imageRendering: 'pixelated', width: w * scale, height: h * scale }} />;
}
