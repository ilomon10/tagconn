// M15 (docs/design/navigation.md section 4.5): `PathFinder` lives in nav/adapter.ts on top of the nav
// grid's macro A*. Same name and `find` semantics as the easystar wrapper this file used to hold; the
// `number[][]` constructor keeps legacy callers (and `?demo=1`) working until the PM wires `map.nav`.
export { PathFinder, collapseToTiles } from './nav/adapter';
