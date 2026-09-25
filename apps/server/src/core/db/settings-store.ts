import type { PlainObject, SettingsOverridesStore } from '../config/index.js';
import type { Db } from './client.js';
import { settingsOverrides } from './schema.js';

/** Runtime settings overrides, one row per top-level section. */
export class DbSettingsStore implements SettingsOverridesStore {
  constructor(private readonly db: Db) {}

  load(): PlainObject {
    const out: PlainObject = {};
    for (const row of this.db.select().from(settingsOverrides).all()) out[row.key] = row.value;
    return out;
  }

  save(overrides: PlainObject): void {
    this.db.transaction((tx) => {
      tx.delete(settingsOverrides).run();
      const rows = Object.entries(overrides).map(([key, value]) => ({ key, value }));
      if (rows.length > 0) tx.insert(settingsOverrides).values(rows).run();
    });
  }
}
