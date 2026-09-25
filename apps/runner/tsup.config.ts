import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // Workspace TS source has no build of its own; bundle it. socket.io-client (a real npm dep) stays external.
  noExternal: ['@tagconn/shared'],
});
