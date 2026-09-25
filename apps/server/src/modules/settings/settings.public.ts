import { MASKED_SECRET, type Settings } from '@tagconn/shared';

/**
 * Strips the real hook token from a Settings value before it leaves the server: every REST response
 * (GET/PATCH/reset), every socket ack (settings:get/update/reset) and the settings:changed broadcast
 * must go through this. Internal consumers (SettingsService.get() itself, the ingest token check,
 * etc.) always see the real value — only this boundary masks it.
 */
export function toPublicSettings(s: Settings): Settings {
  if (!s.server.hookToken) return s; // '' stays '' so the UI can warn "no token"
  return { ...s, server: { ...s.server, hookToken: MASKED_SECRET } };
}
