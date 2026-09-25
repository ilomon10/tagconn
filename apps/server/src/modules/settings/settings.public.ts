import { MASKED_SECRET, type Settings } from '@tagconn/shared';

/**
 * Strips secrets from a Settings value before it leaves the server: every REST response
 * (GET/PATCH/reset), every socket ack (settings:get/update/reset) and the settings:changed broadcast
 * must go through this. Internal consumers (SettingsService.get() itself, the ingest token check,
 * the runner HMAC handshake, etc.) always see the real values — only this boundary masks them.
 * Masks `server.hookToken` (`x-office-token`, ingest) and `runner.token` (the HMAC shared secret for
 * the /runner namespace and pairing challenges; M8 8m).
 */
export function toPublicSettings(s: Settings): Settings {
  const hookToken = s.server.hookToken ? MASKED_SECRET : s.server.hookToken; // '' stays '' so the UI can warn "no token"
  const runnerToken = s.runner.token ? MASKED_SECRET : s.runner.token;
  if (hookToken === s.server.hookToken && runnerToken === s.runner.token) return s;
  return { ...s, server: { ...s.server, hookToken }, runner: { ...s.runner, token: runnerToken } };
}
