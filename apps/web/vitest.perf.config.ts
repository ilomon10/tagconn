import { defineConfig } from 'vitest/config';

// Timing/perf-budget tests only (see vitest.config.ts, which excludes these from the
// default `pnpm test` run): they measure real wall-clock duration against a budget and
// flake when the machine is loaded, so they run on their own via `pnpm test:perf`.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.perf.test.ts'],
  },
});
