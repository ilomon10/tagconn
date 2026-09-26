import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  root: dirname(fileURLToPath(import.meta.url)),
  test: {
    include: ['__tests__/**/*.test.ts'],
    // Timing/perf-budget tests live in *.perf.test.ts and run separately via
    // `pnpm test:perf` (see vitest.perf.config.ts): they measure real wall-clock
    // duration against a budget, which flakes when the machine is loaded, unlike
    // everything else here.
    exclude: [...configDefaults.exclude, '__tests__/**/*.perf.test.ts'],
    environment: 'node',
    // Integration tests spawn `node scripts/install.ts`/`doctor.ts` child
    // processes and do real filesystem work in a temp HOME, so give them
    // more headroom than the default unit-test timeout.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Run test files one at a time: they do real filesystem work (temp
    // HOME dirs, sandboxed installs) and the real-paths guard below must
    // see a clean before/after snapshot around the whole run.
    fileParallelism: false,
    globalSetup: ['./__tests__/support/global-guard.ts'],
  },
});
