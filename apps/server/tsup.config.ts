import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // Workspace TS sources are bundled; real npm deps stay external (native better-sqlite3 in particular).
  noExternal: ['@tagconn/shared'],
  external: ['better-sqlite3'],
});
