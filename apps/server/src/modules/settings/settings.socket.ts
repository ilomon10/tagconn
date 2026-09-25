import type { Deps } from '../../core/di/index.js';
import { ackify } from '../../core/realtime/index.js';
import { SettingsPatchBodySchema } from './settings.schema.js';
import { toPublicSettings } from './settings.public.js';

export function registerSettingsSocket({ office, settings }: Deps<'office' | 'settings'>): void {
  office.on('connection', (socket) => {
    socket.on('settings:get', ackify(() => toPublicSettings(settings.get())));
    socket.on(
      'settings:update',
      ackify((patch: unknown) => toPublicSettings(settings.update(SettingsPatchBodySchema.parse(patch)).settings)),
    );
    socket.on('settings:reset', ackify(() => toPublicSettings(settings.reset().settings)));
  });
}
