import { ALERT_LIMITS, ALERT_PRIORITY } from './types';
import type { AlertInput, AlertItem, AlertKind, AlertQueueState, AlertSettings } from './types';

const KIND_FLAG: Record<AlertKind, 'onAsk' | 'onFailure' | 'onDone'> = { ask: 'onAsk', failure: 'onFailure', done: 'onDone' };

/** tokens = burst */
export function initialAlertQueue(cfg: AlertSettings, nowMs: number): AlertQueueState {
  return { tokens: cfg.burst, refilledAt: nowMs, lastShown: {}, pending: [], visible: [], seq: 0 };
}

/** Lowest priority first, then oldest first: the eviction order when pending is full. */
function evictionOrder(a: AlertItem, b: AlertItem): number {
  return ALERT_PRIORITY[a.kind] - ALERT_PRIORITY[b.kind] || a.createdAt - b.createdAt;
}

export function offerAlert(s: AlertQueueState, input: AlertInput, cfg: AlertSettings, nowMs: number): AlertQueueState {
  // No per-agent "last key" dedupe: the sources already emit one offer per transition, and a repeat
  // (waiting -> active -> waiting, or the same tool failing twice) is a new event. The cooldown and the
  // pending coalescing below absorb real bursts.
  if (!cfg.enabled || !cfg[KIND_FLAG[input.kind]]) return s;

  const priority = ALERT_PRIORITY[input.kind];
  const last = s.lastShown[input.agentId];
  if (last && nowMs - last.at < cfg.agentCooldownSec * 1000 && last.priority >= priority) return s;

  // The same agent already waiting for this kind: it is the same event, whatever the age (a flapping agent
  // must not stack duplicate boxes while tokens or slots are exhausted).
  if (s.pending.some((p) => p.kind === input.kind && p.agentIds.includes(input.agentId))) return s;

  const target = s.pending.find((p) => p.kind === input.kind && nowMs - p.createdAt <= ALERT_LIMITS.coalesceMs);
  if (target) {
    // Different tools -> no single toolName for the coalesced item (the plural copy never names one anyway).
    const { toolName: _t, ...rest } = target;
    const sameTool = target.toolName === input.toolName;
    const merged: AlertItem = {
      ...(sameTool ? target : rest),
      agentIds: [...target.agentIds, input.agentId],
      ...(input.agent || target.agents ? { agents: { ...target.agents, ...(input.agent ? { [input.agentId]: input.agent } : {}) } } : {}),
    };
    return { ...s, pending: s.pending.map((p) => (p === target ? merged : p)) };
  }

  const item: AlertItem = {
    id: `alert-${s.seq + 1}`,
    kind: input.kind,
    agentIds: [input.agentId],
    ...(input.agent ? { agents: { [input.agentId]: input.agent } } : {}),
    ...(input.toolName !== undefined ? { toolName: input.toolName } : {}),
    createdAt: nowMs,
    shownAt: null,
  };
  let pending = [...s.pending, item];
  while (pending.length > ALERT_LIMITS.pendingMax) {
    const drop = [...pending].sort(evictionOrder)[0]!;
    pending = pending.filter((p) => p !== drop);
  }
  return { ...s, pending, seq: s.seq + 1 };
}

export function tickAlerts(
  s: AlertQueueState, cfg: AlertSettings, nowMs: number, hidden: boolean,
): { state: AlertQueueState; shown: readonly AlertItem[] } {
  const elapsed = Math.max(0, nowMs - s.refilledAt);
  let tokens = Math.min(cfg.burst, s.tokens + (elapsed * cfg.perMinute) / 60_000);
  let visible = s.visible;
  // autoDismissSec = 0 keeps visible boxes until dismissed, but pending items still expire after pendingTtlMs.
  if (cfg.autoDismissSec > 0) {
    const ttl = cfg.autoDismissSec * 1000;
    visible = visible.filter((v) => v.shownAt === null || nowMs - v.shownAt < ttl);
  }
  if (hidden) {
    return { state: { ...s, tokens, refilledAt: nowMs, visible, pending: [] }, shown: [] };
  }

  let pending = s.pending.filter((p) => nowMs - p.createdAt <= ALERT_LIMITS.pendingTtlMs);
  const shown: AlertItem[] = [];
  // Drop entries past the cooldown: they no longer gate anything, and the map would grow forever.
  const lastShown: Record<string, { at: number; priority: number }> = {};
  for (const [id, v] of Object.entries(s.lastShown)) if (nowMs - v.at < cfg.agentCooldownSec * 1000) lastShown[id] = v;
  // Already announced within the cooldown at equal or higher priority (e.g. shown after this item was queued):
  // nothing new to say, so drop it instead of showing a duplicate later.
  pending = pending.filter((p) => !p.agentIds.every((id) => (lastShown[id]?.priority ?? -1) >= ALERT_PRIORITY[p.kind]));
  const ready = pending
    .filter((p) => nowMs - p.createdAt >= ALERT_LIMITS.coalesceMs)
    .sort((a, b) => ALERT_PRIORITY[b.kind] - ALERT_PRIORITY[a.kind] || a.createdAt - b.createdAt);
  for (const item of ready) {
    if (tokens < 1 || visible.length + shown.length >= cfg.maxVisible) break;
    tokens -= 1;
    const out = { ...item, shownAt: nowMs };
    shown.push(out);
    for (const id of item.agentIds) lastShown[id] = { at: nowMs, priority: ALERT_PRIORITY[item.kind] };
  }
  if (shown.length) {
    const ids = new Set(shown.map((x) => x.id));
    pending = pending.filter((p) => !ids.has(p.id));
    visible = [...visible, ...shown];
  }
  return { state: { ...s, tokens, refilledAt: nowMs, lastShown, pending, visible }, shown };
}

export function dismissAlert(s: AlertQueueState, id: string): AlertQueueState {
  if (!s.visible.some((v) => v.id === id)) return s;
  return { ...s, visible: s.visible.filter((v) => v.id !== id) };
}
