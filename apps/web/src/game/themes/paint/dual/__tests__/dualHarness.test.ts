// Verifies the shared painter suite against a trivial theme: hooks that draw nothing and a `paintWallBase`
// that only fills the tile (zero `rand()` draws, like `paintModernWall`). D1-D3 run the same suite on real art.
import { modernTheme } from '../../../modern';
import type { ThemeDefinition } from '../../../types';
import { runDualPainterSuite } from './dualHarness';

const trivialTheme: ThemeDefinition = {
  ...modernTheme,
  paintWallBase: (g, px, py) => g.fillRect(px, py, 16, 16),
  paintDualFloor: () => undefined,
  paintDualWall: () => undefined,
};

runDualPainterSuite(trivialTheme, 'trivial no-op');
