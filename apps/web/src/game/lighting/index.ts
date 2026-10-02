// M16: the lighting modules' public surface (docs/design/lighting.md section 2.1). Types only until L1/L2 land;
// each task appends its own re-exports here.
export type * from './types';
export * from './clock';
export * from './sun';
export * from './fallback';
export * from './palette';
export * from './heights';
export * from './occluders';
export * from './visibility';
export * from './sources';
export * from './plan';
export * from './shadows';
export * from './LightmapLayer';
export * from './ShadowLayer';
export * from './LightingController';
export * from './heightmap';
