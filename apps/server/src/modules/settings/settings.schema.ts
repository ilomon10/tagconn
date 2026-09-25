import { z } from 'zod';

/** Shape-checked loosely here; SettingsService validates the merged result against SettingsSchema. */
export const SettingsPatchBodySchema = z.record(z.string(), z.unknown());
