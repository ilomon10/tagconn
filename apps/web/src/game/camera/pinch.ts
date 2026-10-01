/** Two-finger pinch helpers (M12 responsive): plain `{x, y}` points so they are testable without Phaser. */
interface Pt {
  x: number;
  y: number;
}

export function pinchDistance(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function pinchMidpoint(a: Pt, b: Pt): Pt {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
