import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sfxBus, type SfxEvent, type SfxListenerPose } from '../sfxBus';
import { listenerFromCamera, pickProximitySfx, ProximitySfx, type ProximityActor, type ProximityState } from '../sfxProximity';

const L: SfxListenerPose = { x: 500, y: 500, halfW: 200, halfH: 100 };
const fresh: ProximityState = { lastStepAt: -Infinity, lastTypeAt: -Infinity };
const walker = (x: number, y: number): ProximityActor => ({ x, y, walking: true, typing: false });
const typist = (x: number, y: number): ProximityActor => ({ x, y, walking: false, typing: true });

describe('pickProximitySfx', () => {
  it('picks the nearest walking and typing actors', () => {
    const { events } = pickProximitySfx([walker(650, 500), walker(520, 500), typist(600, 500), typist(480, 480)], L, 1000, fresh);
    expect(events).toEqual([
      { id: 'footstep', at: { x: 520, y: 500 }, gain: 0.35 },
      { id: 'typing', at: { x: 480, y: 480 }, gain: 0.25 },
    ]);
  });
  it('ignores actors outside the view', () => {
    expect(pickProximitySfx([walker(900, 500), typist(500, 900)], L, 1000, fresh).events).toEqual([]);
  });
  it('throttles footsteps to 280 ms and typing to 180 ms', () => {
    const actors = [walker(500, 500), typist(510, 500)];
    const a = pickProximitySfx(actors, L, 1000, fresh);
    expect(a.events).toHaveLength(2);
    const b = pickProximitySfx(actors, L, 1100, a.state);
    expect(b.events).toEqual([]);
    const c = pickProximitySfx(actors, L, 1190, b.state);
    expect(c.events.map((e) => e.id)).toEqual(['typing']);
    const d = pickProximitySfx(actors, L, 1290, c.state);
    expect(d.events.map((e) => e.id)).toEqual(['footstep']);
  });
  it('does not consume the throttle when nothing qualified', () => {
    expect(pickProximitySfx([walker(900, 900)], L, 1000, fresh).state).toEqual(fresh);
  });
});

describe('listenerFromCamera', () => {
  it('maps the camera midpoint and half view', () => {
    expect(listenerFromCamera({ midPoint: { x: 1, y: 2 }, worldView: { width: 100, height: 60 } })).toEqual({ x: 1, y: 2, halfW: 50, halfH: 30 });
  });
});

describe('ProximitySfx', () => {
  beforeEach(() => sfxBus.clear());
  it('throttles ticks to 100 ms, sets the listener and emits', () => {
    const got: SfxEvent[] = [];
    sfxBus.on((e) => got.push(e));
    const p = new ProximitySfx();
    p.tick(1000, () => [walker(500, 500)], () => L);
    expect(sfxBus.listener()).toEqual(L);
    expect(got).toHaveLength(1);
    const skipped = vi.fn(() => [walker(500, 500)]);
    p.tick(1050, skipped, () => ({ ...L, x: 1 }));
    expect(skipped).not.toHaveBeenCalled();
    expect(sfxBus.listener()).toEqual(L);
    p.tick(1400, () => [walker(500, 500)], () => L);
    expect(got).toHaveLength(2);
  });
});
