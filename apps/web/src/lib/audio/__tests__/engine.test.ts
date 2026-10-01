import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioMix } from '../types';

vi.mock('../sfxr', () => ({ renderSfx: vi.fn(() => new Float32Array(10)) }));
vi.mock('../presets', () => ({ SFX_PRESETS: new Proxy({}, { get: () => ({}) }) }));
const stopAmbient = vi.fn();
const stopMusic = vi.fn();
vi.mock('../music', () => ({ createMusic: vi.fn(() => ({ stop: stopMusic })) }));
vi.mock('../ambient', () => ({ createAmbient: vi.fn(() => ({ stop: stopAmbient })) }));

import { createAmbient } from '../ambient';
import { createMusic } from '../music';
import { createAudioEngine, getAudioEngine } from '../engine';
import { renderSfx } from '../sfxr';

class FakeNode {
  gain = { value: 1, cancelScheduledValues: vi.fn(), setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() };
  pan = { value: 0 };
  buffer: unknown = null;
  onended: (() => void) | null = null;
  connect = vi.fn();
  disconnect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
}
class FakeCtx {
  currentTime = 0;
  sampleRate = 1000;
  destination = new FakeNode();
  sources: FakeNode[] = [];
  suspend = vi.fn(async () => {});
  resume = vi.fn(async () => {});
  close = vi.fn(async () => {});
  createGain = () => new FakeNode();
  createStereoPanner = () => new FakeNode();
  createBufferSource = () => {
    const n = new FakeNode();
    this.sources.push(n);
    return n;
  };
  createBuffer = vi.fn(() => ({ getChannelData: () => new Float32Array(10) }));
}

const ALL: AudioMix = { master: 0.5, sfx: true, ambient: true, alerts: true, footsteps: true };

function setup() {
  const ctx = new FakeCtx();
  const target = new EventTarget();
  const engine = createAudioEngine({ createContext: () => ctx as unknown as AudioContext, target });
  return { ctx, target, engine };
}
const unlock = (t: EventTarget) => t.dispatchEvent(new Event('pointerdown'));

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

describe('audio engine', () => {
  it('is inert without a context', () => {
    const e = createAudioEngine({ createContext: () => null, target: new EventTarget() });
    e.setMix(ALL);
    e.play('ui-click');
    e.setAmbient('office-day');
    e.destroy();
    expect(e.unlocked).toBe(false);
  });

  it('drops sounds until the first gesture, then unlocks once and resumes', () => {
    const { ctx, target, engine } = setup();
    engine.setMix(ALL);
    engine.play('door-bell');
    expect(ctx.sources).toHaveLength(0);
    unlock(target);
    expect(engine.unlocked).toBe(true);
    expect(ctx.resume).toHaveBeenCalledTimes(1);
    target.dispatchEvent(new Event('keydown'));
    expect(ctx.resume).toHaveBeenCalledTimes(1);
    engine.play('door-bell');
    expect(ctx.sources).toHaveLength(1);
    expect(ctx.sources[0]!.start).toHaveBeenCalled();
  });

  it('gates by category (ui follows sfx)', () => {
    const { ctx, target, engine } = setup();
    unlock(target);
    engine.setMix({ ...ALL, sfx: false, alerts: false });
    engine.play('door-bell');
    engine.play('ui-click');
    engine.play('alert-done');
    expect(ctx.sources).toHaveLength(0);
    engine.play('footstep');
    expect(ctx.sources).toHaveLength(1);
    engine.setMix({ ...ALL, footsteps: false });
    ctx.currentTime = 10;
    engine.play('footstep');
    expect(ctx.sources).toHaveLength(1);
  });

  it('caps sfx at 8 minus the alert/ui reserve, frees on end', () => {
    const { ctx, target, engine } = setup();
    unlock(target);
    engine.setMix(ALL);
    const ids = ['door-bell', 'meeting-gong', 'bark', 'meow', 'slime', 'whistle', 'roar', 'mop'] as const;
    for (const id of ids) engine.play(id);
    expect(ctx.sources).toHaveLength(6);
    engine.play('ui-click');
    engine.play('ui-open');
    expect(ctx.sources).toHaveLength(8);
    engine.play('ui-close');
    expect(ctx.sources).toHaveLength(8);
    ctx.sources[0]!.onended?.();
    engine.play('ui-close');
    expect(ctx.sources).toHaveLength(9);
  });

  it('alerts are not starved by footsteps and typing', () => {
    const { ctx, target, engine } = setup();
    unlock(target);
    engine.setMix(ALL);
    for (let i = 0; i < 12; i++) {
      ctx.currentTime = i;
      engine.play(i % 2 ? 'typing' : 'footstep');
    }
    expect(ctx.sources).toHaveLength(6);
    engine.play('alert-done');
    ctx.currentTime = 20;
    engine.play('alert-ask');
    expect(ctx.sources).toHaveLength(8);
    // pool full: an alert steals the oldest footstep voice
    ctx.currentTime = 30;
    engine.play('alert-fail');
    expect(ctx.sources).toHaveLength(9);
    expect(ctx.sources[0]!.stop).toHaveBeenCalled();
  });

  it('a throttled alert does not steal a voice', () => {
    const { ctx, target, engine } = setup();
    unlock(target);
    engine.setMix(ALL);
    for (let i = 0; i < 12; i++) {
      ctx.currentTime = i;
      engine.play(i % 2 ? 'typing' : 'footstep');
    }
    ctx.currentTime = 20;
    engine.play('alert-done');
    engine.play('alert-ask');
    ctx.currentTime = 30;
    engine.play('alert-fail');
    expect(ctx.sources).toHaveLength(9);
    ctx.currentTime = 30.01; // inside the 60 ms per-id throttle
    engine.play('alert-fail');
    expect(ctx.sources).toHaveLength(9);
    expect(ctx.sources[1]!.stop).not.toHaveBeenCalled();
    expect(ctx.sources.filter((n) => n.stop.mock.calls.length > 0)).toHaveLength(1);
  });

  it('getAudioEngine is recreated after destroy', () => {
    class Ctx extends FakeCtx {}
    vi.stubGlobal('window', Object.assign(new EventTarget(), { AudioContext: Ctx }));
    const a = getAudioEngine();
    expect(getAudioEngine()).toBe(a);
    a.destroy();
    expect(getAudioEngine()).not.toBe(a);
    getAudioEngine().destroy();
    vi.unstubAllGlobals();
  });

  it('enforces per-id min interval (60 ms, footstep 250, typing 150)', () => {
    const { ctx, target, engine } = setup();
    unlock(target);
    engine.setMix(ALL);
    engine.play('bark');
    ctx.currentTime = 0.03;
    engine.play('bark');
    expect(ctx.sources).toHaveLength(1);
    ctx.currentTime = 0.07;
    engine.play('bark');
    expect(ctx.sources).toHaveLength(2);
    engine.play('footstep');
    ctx.currentTime = 0.25;
    engine.play('footstep');
    expect(ctx.sources).toHaveLength(3);
    ctx.currentTime = 0.33;
    engine.play('footstep');
    expect(ctx.sources).toHaveLength(4);
    engine.play('typing');
    ctx.currentTime = 0.4;
    engine.play('typing');
    expect(ctx.sources).toHaveLength(5);
  });

  it('renders each id once (buffer cache)', () => {
    const { ctx, target, engine } = setup();
    unlock(target);
    engine.setMix(ALL);
    engine.play('bark');
    ctx.currentTime = 1;
    engine.play('bark');
    expect(renderSfx).toHaveBeenCalledTimes(1);
    expect(ctx.createBuffer).toHaveBeenCalledTimes(1);
  });

  it('skips empty (stub) renders without throwing', () => {
    vi.mocked(renderSfx).mockReturnValueOnce(new Float32Array(0));
    const { ctx, target, engine } = setup();
    unlock(target);
    engine.setMix(ALL);
    engine.play('bark');
    expect(ctx.sources).toHaveLength(0);
  });

  it('suspends at master 0 and resumes after', () => {
    const { ctx, target, engine } = setup();
    unlock(target);
    engine.setMix({ ...ALL, master: 0 });
    expect(ctx.suspend).not.toHaveBeenCalled(); // ramps down first
    vi.advanceTimersByTime(1000);
    expect(ctx.suspend).toHaveBeenCalled();
    engine.play('bark');
    expect(ctx.sources).toHaveLength(0);
    engine.setMix(ALL);
    expect(ctx.resume).toHaveBeenCalledTimes(1);
  });

  it('runs ambient only when unlocked, enabled and audible; restarts on kind change', () => {
    const { target, engine } = setup();
    engine.setMix(ALL);
    engine.setAmbient('office-day');
    expect(createAmbient).not.toHaveBeenCalled();
    unlock(target);
    expect(createAmbient).toHaveBeenCalledTimes(1);
    engine.setAmbient('rift');
    expect(stopAmbient).toHaveBeenCalledTimes(1);
    expect(createAmbient).toHaveBeenCalledTimes(2);
    engine.setMix({ ...ALL, ambient: false });
    expect(stopAmbient).toHaveBeenCalledTimes(2);
    engine.setMix(ALL);
    expect(createAmbient).toHaveBeenCalledTimes(3);
    engine.setAmbient(null);
    expect(stopAmbient).toHaveBeenCalledTimes(3);
  });

  it('plays battle music only when unlocked, sfx on and audible; ducks ambient meanwhile', () => {
    const { target, engine } = setup();
    engine.setMix(ALL);
    engine.setMusic('guild', 300);
    expect(createMusic).not.toHaveBeenCalled();
    unlock(target);
    expect(createMusic).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createMusic).mock.calls[0]![1]).toBe('guild');
    expect(vi.mocked(createMusic).mock.calls[0]![3]).toBe(300);
    engine.setMusic('guild', 300);
    expect(createMusic).toHaveBeenCalledTimes(1);
    engine.setMusic('rift');
    expect(stopMusic).toHaveBeenCalledWith(400);
    expect(createMusic).toHaveBeenCalledTimes(2);
    engine.setMix({ ...ALL, sfx: false });
    expect(stopMusic).toHaveBeenCalledTimes(2);
    engine.setMix(ALL);
    expect(createMusic).toHaveBeenCalledTimes(3);
    engine.setMix({ ...ALL, master: 0 });
    expect(stopMusic).toHaveBeenCalledTimes(3);
    engine.setMix(ALL);
    engine.setMusic(null);
    expect(stopMusic).toHaveBeenCalledTimes(4);
  });

  it('destroy removes listeners and closes the context', () => {
    const { ctx, target, engine } = setup();
    engine.destroy();
    unlock(target);
    expect(engine.unlocked).toBe(false);
    expect(ctx.close).toHaveBeenCalled();
  });
});
