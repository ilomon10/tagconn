/** Resolves true once `pred()` holds, false after `timeoutMs`. Polls the latest state through the closure. */
export async function waitFor(pred: () => boolean, timeoutMs: number, intervalMs = 250): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return true;
}

/** "m:ss" left until `expiresAt` (epoch ms), or null once expired. */
export function countdown(expiresAt: number, now: number): string | null {
  const left = Math.ceil((expiresAt - now) / 1000);
  if (left <= 0) return null;
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
}
