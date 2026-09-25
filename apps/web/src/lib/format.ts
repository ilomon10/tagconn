export function elapsed(fromMs: number, toMs: number): string {
  const s = Math.max(0, Math.floor((toMs - fromMs) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

export const clock = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export const shortId = (id: string) => (id.startsWith('main:') ? `main:${id.slice(5, 13)}` : id.slice(0, 10));

/** Compact token count: 1234 → "1.2k", 1234567 → "1.2M". Subscription plans don't have a token cost, only a count. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const abs = Math.abs(n);
  const round1 = (x: number) => {
    const r = Math.round(x * 10) / 10;
    return Number.isInteger(r) ? String(r) : r.toFixed(1);
  };
  if (abs < 1_000) return String(Math.round(n));
  if (abs < 1_000_000) return `${round1(n / 1_000)}k`;
  return `${round1(n / 1_000_000)}M`;
}
