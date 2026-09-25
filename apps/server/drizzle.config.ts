import { defineConfig } from 'drizzle-kit';

// Only used for `pnpm db:generate` (inspection); runtime migrations live in src/core/db/migrations.ts.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/core/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.OFFICE_STORAGE__DB_PATH ?? './data/office.db' },
});
