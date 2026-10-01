import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SFX_CATEGORY, SFX_IDS, sfxBus } from './sfxBus';

beforeEach(() => sfxBus.clear());

describe('sfxBus', () => {
  it('emits to subscribers and unsubscribes', () => {
    const cb = vi.fn();
    const off = sfxBus.on(cb);
    sfxBus.emit({ id: 'bark', at: { x: 1, y: 2 } });
    expect(cb).toHaveBeenCalledWith({ id: 'bark', at: { x: 1, y: 2 } });
    off();
    sfxBus.emit({ id: 'meow' });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('isolates a throwing listener', () => {
    const good = vi.fn();
    sfxBus.on(() => {
      throw new Error('boom');
    });
    sfxBus.on(good);
    expect(() => sfxBus.emit({ id: 'ui-click' })).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
  });

  it('stores the listener pose', () => {
    expect(sfxBus.listener()).toBeNull();
    sfxBus.setListener({ x: 1, y: 2, halfW: 3, halfH: 4 });
    expect(sfxBus.listener()).toEqual({ x: 1, y: 2, halfW: 3, halfH: 4 });
    sfxBus.setListener(null);
    expect(sfxBus.listener()).toBeNull();
  });

  it('replays the last ambient context to late subscribers', () => {
    sfxBus.setAmbient({ style: 'guild', night: false });
    sfxBus.setAmbient({ style: 'rift', night: true });
    const cb = vi.fn();
    const off = sfxBus.onAmbient(cb);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenLastCalledWith({ style: 'rift', night: true });
    sfxBus.setAmbient({ style: 'modern', night: false });
    expect(cb).toHaveBeenCalledTimes(2);
    off();
    sfxBus.setAmbient({ style: 'guild', night: true });
    expect(cb).toHaveBeenCalledTimes(2);
    expect(sfxBus.ambient()).toEqual({ style: 'guild', night: true });
  });

  it('clear drops listeners and state', () => {
    const cb = vi.fn();
    sfxBus.on(cb);
    sfxBus.setAmbient({ style: 'guild', night: false });
    sfxBus.clear();
    sfxBus.emit({ id: 'bark' });
    expect(cb).not.toHaveBeenCalled();
    expect(sfxBus.ambient()).toBeNull();
  });

  it('SFX_CATEGORY covers every id with the documented category', () => {
    for (const id of SFX_IDS) expect(SFX_CATEGORY[id]).toBeDefined();
    expect(Object.keys(SFX_CATEGORY).sort()).toEqual([...SFX_IDS].sort());
    expect(SFX_CATEGORY['alert-ask']).toBe('alerts');
    expect(SFX_CATEGORY.footstep).toBe('footsteps');
    expect(SFX_CATEGORY['ui-open']).toBe('ui');
    expect(SFX_CATEGORY.roar).toBe('sfx');
    expect(SFX_CATEGORY['battle-encounter']).toBe('alerts');
    expect(SFX_CATEGORY['battle-text']).toBe('ui');
    expect(SFX_CATEGORY['battle-hit']).toBe('sfx');
  });
});

describe('sfxBus music channel', () => {
  it('replays the last music request to late subscribers and stops with null', () => {
    sfxBus.clear();
    sfxBus.setMusic({ kind: 'battle', style: 'rift' });
    const cb = vi.fn();
    const off = sfxBus.onMusic(cb);
    expect(cb).toHaveBeenCalledWith({ kind: 'battle', style: 'rift' });
    sfxBus.setMusic(null);
    expect(cb).toHaveBeenLastCalledWith(null);
    expect(sfxBus.music()).toBeNull();
    off();
    sfxBus.setMusic({ kind: 'battle', style: 'guild' });
    expect(cb).toHaveBeenCalledTimes(2);
    sfxBus.clear();
    expect(sfxBus.music()).toBeNull();
  });
});
