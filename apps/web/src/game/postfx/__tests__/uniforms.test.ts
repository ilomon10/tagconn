import { describe, expect, it } from 'vitest';
import { MULTIVERSE_THEME_ID } from '@tagconn/shared';
import { resolveShaderConfig, type ShaderSettings } from '../uniforms';

const BASE: ShaderSettings = {
  enabled: true,
  quality: 'auto',
  bloom: 0.45,
  vignette: 0.3,
  grading: true,
  lightGlow: true,
  scanlines: false,
};

describe('resolveShaderConfig', () => {
  it('turns everything off when shaders are disabled, regardless of the individual flags', () => {
    const cfg = resolveShaderConfig({ ...BASE, scanlines: true }, 'modern', 'high');
    expect(cfg.enabled).toBe(true); // sanity: BASE itself is enabled
    const off = resolveShaderConfig({ ...BASE, enabled: false, scanlines: true }, 'modern', 'high');
    expect(off.enabled).toBe(false);
    expect(off.grading).toBeNull();
    expect(off.vignetteStrength).toBe(0);
    expect(off.bloomStrength).toBe(0);
    expect(off.lightGlow).toBe(false);
    expect(off.scanlines).toBe(false);
    void cfg;
  });

  it('maps grading/vignette/bloom straight from settings when on', () => {
    const cfg = resolveShaderConfig(BASE, 'guild', 'high');
    expect(cfg.grading).not.toBeNull();
    expect(cfg.grading?.warmth).toBeGreaterThan(0);
    expect(cfg.vignetteStrength).toBe(0.3);
    expect(cfg.bloomStrength).toBe(0.45);
    expect(cfg.lightGlow).toBe(true);
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

  it('only enables scanlines for the modern style', () => {
    const modern = resolveShaderConfig({ ...BASE, scanlines: true }, 'modern', 'high');
    const guild = resolveShaderConfig({ ...BASE, scanlines: true }, 'guild', 'high');
    const rift = resolveShaderConfig({ ...BASE, scanlines: true }, MULTIVERSE_THEME_ID, 'high');
    expect(modern.scanlines).toBe(true);
    expect(guild.scanlines).toBe(false);
    expect(rift.scanlines).toBe(false);
  });

  it('carries the resolved quality tier through to the light cap', () => {
    expect(resolveShaderConfig(BASE, 'modern', 'low').maxLights).toBeLessThan(resolveShaderConfig(BASE, 'modern', 'high').maxLights);
  });
});
