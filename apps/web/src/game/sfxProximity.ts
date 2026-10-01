// M13: footsteps and typing ticks for actors near the camera (docs/design/office-life.md 3.7.2).
import { sfxBus, type SfxEvent, type SfxListenerPose } from './sfxBus';

export interface ProximityActor { x: number; y: number; walking: boolean; typing: boolean }
export interface ProximityState { lastStepAt: number; lastTypeAt: number }

const STEP_INTERVAL_MS = 280;
const TYPE_INTERVAL_MS = 180;
const TICK_INTERVAL_MS = 100;
const STEP_GAIN = 0.35;
const TYPE_GAIN = 0.25;

/** Inside the view rectangle; the engine applies the real falloff. */
function inView(a: ProximityActor, l: SfxListenerPose): boolean {
  return Math.abs(a.x - l.x) <= l.halfW && Math.abs(a.y - l.y) <= l.halfH;
}

/** At most one footstep per 280 ms (nearest walking actor) and one typing tick per 180 ms (nearest typing actor),
 *  only for actors in view; gains 0.35 / 0.25. */
export function pickProximitySfx(actors: Iterable<ProximityActor>, l: SfxListenerPose, nowMs: number, s: ProximityState): { events: SfxEvent[]; state: ProximityState } {
  const stepDue = nowMs - s.lastStepAt >= STEP_INTERVAL_MS;
  const typeDue = nowMs - s.lastTypeAt >= TYPE_INTERVAL_MS;
  let step: ProximityActor | null = null;
  let stepD = Infinity;
  let type: ProximityActor | null = null;
  let typeD = Infinity;
  if (stepDue || typeDue) {
    for (const a of actors) {
      if (!inView(a, l)) continue;
      const d = (a.x - l.x) ** 2 + (a.y - l.y) ** 2;
      if (stepDue && a.walking && d < stepD) { step = a; stepD = d; }
      if (typeDue && a.typing && d < typeD) { type = a; typeD = d; }
    }
  }
  const events: SfxEvent[] = [];
  if (step) events.push({ id: 'footstep', at: { x: step.x, y: step.y }, gain: STEP_GAIN });
  if (type) events.push({ id: 'typing', at: { x: type.x, y: type.y }, gain: TYPE_GAIN });
  return {
    events,
    state: { lastStepAt: step ? nowMs : s.lastStepAt, lastTypeAt: type ? nowMs : s.lastTypeAt },
  };
}

export function listenerFromCamera(cam: { midPoint: { x: number; y: number }; worldView: { width: number; height: number } }): SfxListenerPose {
  return { x: cam.midPoint.x, y: cam.midPoint.y, halfW: cam.worldView.width / 2, halfH: cam.worldView.height / 2 };
}

export class ProximitySfx {
  private state: ProximityState = { lastStepAt: -Infinity, lastTypeAt: -Infinity };
  private lastTickAt = -Infinity;

  /** 100 ms throttle: sets sfxBus' listener and emits picked events. */
  tick(nowMs: number, actors: Iterable<ProximityActor>, listener: SfxListenerPose): void {
    if (nowMs - this.lastTickAt < TICK_INTERVAL_MS) return;
    this.lastTickAt = nowMs;
    sfxBus.setListener(listener);
    const { events, state } = pickProximitySfx(actors, listener, nowMs, this.state);
    this.state = state;
    for (const e of events) sfxBus.emit(e);
  }
}
