import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Timing/perf-budget tests live in *.perf.test.ts and run separately via
    // `pnpm test:perf` (see vitest.perf.config.ts): they measure real wall-clock
    // duration against a budget, which flakes when the machine is loaded, unlike
    // everything else here.
    exclude: [...configDefaults.exclude, 'src/**/*.perf.test.ts'],
  },
});
