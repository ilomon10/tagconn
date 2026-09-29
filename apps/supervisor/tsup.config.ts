import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { supervisor: 'src/main.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // ONE file for the desktop app's sidecar: workspace TS source (@tagconn/setup has .ts imports) and zod are bundled in.
  noExternal: ['@tagconn/shared', '@tagconn/setup', 'zod'],
});
