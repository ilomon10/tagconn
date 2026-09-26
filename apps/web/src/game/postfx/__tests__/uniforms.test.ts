import { describe, expect, it } from 'vitest';
import { MULTIVERSE_THEME_ID } from '@tagconn/shared';
import { resolveShaderConfig, type ScreenOverride, type ShaderSettings } from '../uniforms';

const BASE: ShaderSettings = {
  enabled: true,
  quality: 'auto',
  bloom: 0.45,
  vignette: 0.3,
  vignetteStyle: 'pixel',
  vignetteSteps: 4,
  vignettePixel: 4,
  vignetteSize: 0.12,
  screen: 'off',
  screenStrength: 0.6,
  grading: true,
  lightGlow: true,
  scanlines: false,
};

describe('resolveShaderConfig', () => {
  it('turns everything off when shaders are disabled, regardless of the individual flags', () => {
    const cfg = resolveShaderConfig({ ...BASE, scanlines: true }, 'modern', 'high');
    expect(cfg.enabled).toBe(true); // sanity: BASE itself is enabled
    const off = resolveShaderConfig({ ...BASE, enabled: false, scanlines: true, screen: 'crt' }, 'modern', 'high');
    expect(off.enabled).toBe(false);
    expect(off.grading).toBeNull();
    expect(off.vignette.strength).toBe(0);
    expect(off.bloomStrength).toBe(0);
    expect(off.lightGlow).toBe(false);
    expect(off.screen).toEqual({ mode: 'off', strength: 0 });
    void cfg;
  });

  it('turns everything off even with an override present, when shaders are disabled', () => {
    const override: ScreenOverride = { on: true, effect: 'crt' };
    const off = resolveShaderConfig({ ...BASE, enabled: false }, 'modern', 'high', override);
    expect(off.screen).toEqual({ mode: 'off', strength: 0 });
  });

  it('maps grading/vignette/bloom straight from settings when on', () => {
    const cfg = resolveShaderConfig(BASE, 'guild', 'high');
    expect(cfg.grading).not.toBeNull();
    expect(cfg.grading?.warmth).toBeGreaterThan(0);
    expect(cfg.vignette).toEqual({ strength: 0.3, style: 'pixel', steps: 4, pixel: 4, size: 0.12 });
    expect(cfg.bloomStrength).toBe(0.45);
    expect(cfg.lightGlow).toBe(true);
  });

  it('carries the smooth vignette style straight through, unchanged', () => {
    const cfg = resolveShaderConfig({ ...BASE, vignetteStyle: 'smooth', vignetteSteps: 6, vignettePixel: 8 }, 'modern', 'high');
    expect(cfg.vignette).toEqual({ strength: 0.3, style: 'smooth', steps: 6, pixel: 8, size: 0.12 });
  });

  it('drops grading to null when the grading flag is off, independent of `enabled`', () => {
    const cfg = resolveShaderConfig({ ...BASE, grading: false }, 'modern', 'high');
    expect(cfg.grading).toBeNull();
  });

  it('zeroes bloom strength when lightGlow is off, even if `bloom` is nonzero', () => {
    const cfg = resolveShaderConfig({ ...BASE, lightGlow: false }, 'modern', 'high');
    expect(cfg.bloomStrength).toBe(0);
    expect(cfg.lightGlow).toBe(false);
  });

  describe('screen effect resolution', () => {
    it('uses `screen` directly when set, regardless of the legacy `scanlines` flag', () => {
      const cfg = resolveShaderConfig({ ...BASE, screen: 'lcd', scanlines: true }, 'modern', 'high');
      expect(cfg.screen).toEqual({ mode: 'lcd', strength: 0.6 });
    });

    it('legacy: `scanlines` on the modern style maps to crt only when `screen` is still off', () => {
      const modern = resolveShaderConfig({ ...BASE, scanlines: true, screen: 'off' }, 'modern', 'high');
      const guild = resolveShaderConfig({ ...BASE, scanlines: true, screen: 'off' }, 'guild', 'high');
      const rift = resolveShaderConfig({ ...BASE, scanlines: true, screen: 'off' }, MULTIVERSE_THEME_ID, 'high');
      expect(modern.screen).toEqual({ mode: 'crt', strength: 0.6 });
      expect(guild.screen).toEqual({ mode: 'off', strength: 0.6 });
      expect(rift.screen).toEqual({ mode: 'off', strength: 0.6 });
    });

    it('is off by default when neither `screen` nor `scanlines` is set', () => {
      const cfg = resolveShaderConfig(BASE, 'modern', 'high');
      expect(cfg.screen).toEqual({ mode: 'off', strength: 0.6 });
    });

    it('a per-browser override takes precedence over `screen`/`scanlines`', () => {
      const override: ScreenOverride = { on: true, effect: 'vhs' };
      const cfg = resolveShaderConfig({ ...BASE, screen: 'crt' }, 'modern', 'high', override);
      expect(cfg.screen).toEqual({ mode: 'vhs', strength: 0.6 });
    });

    it('an override with `on: false` forces it off even when `screen` is set', () => {
      const override: ScreenOverride = { on: false, effect: 'crt' };
      const cfg = resolveShaderConfig({ ...BASE, screen: 'crt' }, 'modern', 'high', override);
      expect(cfg.screen).toEqual({ mode: 'off', strength: 0.6 });
    });
  });

  it('carries the resolved quality tier through to the light cap', () => {
    expect(resolveShaderConfig(BASE, 'modern', 'low').maxLights).toBeLessThan(resolveShaderConfig(BASE, 'modern', 'high').maxLights);
  });
});
