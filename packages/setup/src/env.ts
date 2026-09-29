import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { secretOptions, touch, type SetupContext } from './context.ts';
import { writeSecretFile } from './secrets.ts';
import { isValidToken, TOKEN_RE } from './validate.ts';

export function parseEnvFile(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    map.set(key, value);
  }
  return map;
}

export function upsertEnvLine(lines: string[], key: string, value: string): string[] {
  const prefix = `${key}=`;
  const idx = lines.findIndex((l) => l.startsWith(prefix));
  const newLine = `${key}=${value}`;
  if (idx === -1) {
    return [...lines, newLine];
  }
  const copy = [...lines];
  copy[idx] = newLine;
  return copy;
}

export function generateToken(): string {
  return randomBytes(24).toString('hex');
}

/** Ensures the repo .env exists (seeded from .env.example) and has a hook token. Returns the token. */
export function ensureRepoEnv(ctx: SetupContext, envFile: string): string {
  const exampleFile = ctx.resources.envExample;
  let text: string;
  if (existsSync(envFile)) {
    text = readFileSync(envFile, 'utf8');
  } else if (existsSync(exampleFile)) {
    text = readFileSync(exampleFile, 'utf8');
  } else {
    text = 'OFFICE_HOOK_TOKEN=\nOFFICE_PORT=4317\nOFFICE_WEB_PORT=4318\n';
  }
  const parsed = parseEnvFile(text);
  let token = parsed.get('OFFICE_HOOK_TOKEN') || '';
  let lines = text.split('\n');
  // Drop a trailing empty line so upsert doesn't accumulate blank lines.
  if (lines.length && lines[lines.length - 1] === '') lines = lines.slice(0, -1);

  if (!token) {
    token = generateToken();
    lines = upsertEnvLine(lines, 'OFFICE_HOOK_TOKEN', token);
    ctx.log(`  generated new OFFICE_HOOK_TOKEN`);
  } else if (!isValidToken(token)) {
    throw new Error(
      `OFFICE_HOOK_TOKEN in ${envFile} is invalid: must match ${TOKEN_RE} (16-128 lowercase hex chars). ` +
        `Fix it, or clear the line and re-run to generate a new one.`,
    );
  } else {
    ctx.log(`  kept existing OFFICE_HOOK_TOKEN`);
  }

  const newText = lines.join('\n') + '\n';
  if (ctx.dryRun) {
    ctx.log(`  [dry-run] would write ${envFile} (mode 600)`);
  } else {
    mkdirSync(dirname(envFile), { recursive: true });
    writeSecretFile(envFile, newText, secretOptions(ctx));
    touch(ctx, envFile);
    ctx.log(`  wrote ${envFile}`);
  }
  return token;
}

/**
 * Upserts OFFICE_RUNNER__TOKEN into the repo .env (same file/convention as OFFICE_HOOK_TOKEN), and mirrors
 * the runner's allowed dirs to the server: the server re-checks them before queuing a quest (empty = deny
 * all), and `runner.enabled` defaults to false, so the runner is only switched on when dirs are allowed.
 */
export function ensureRunnerTokenEnv(ctx: SetupContext, envFile: string, runnerToken: string, allowedDirs: string[]): void {
  const text = existsSync(envFile) ? readFileSync(envFile, 'utf8') : '';
  let lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines = lines.slice(0, -1);
  lines = upsertEnvLine(lines, 'OFFICE_RUNNER__TOKEN', runnerToken);
  lines = upsertEnvLine(lines, 'OFFICE_RUNNER__ALLOWED_PROJECT_DIRS', JSON.stringify(allowedDirs));
  lines = upsertEnvLine(lines, 'OFFICE_RUNNER__ENABLED', allowedDirs.length > 0 ? 'true' : 'false');
  const newText = lines.join('\n') + '\n';
  if (ctx.dryRun) {
    ctx.log(`  [dry-run] would set OFFICE_RUNNER__TOKEN in ${envFile}`);
    return;
  }
  writeSecretFile(envFile, newText, secretOptions(ctx));
  touch(ctx, envFile);
  ctx.log(`  set OFFICE_RUNNER__TOKEN in ${envFile}`);
}
