#!/usr/bin/env node
// tagconn pairing CLI (`pnpm office:pair`): mints a browser pairing code by proving
// possession of the runner token over HMAC-SHA256 - the raw token is never sent on
// the wire. See docs/design/runner-and-helpdesk.md §5.2 for the two-step protocol
// this mirrors, and packages/shared/src/auth.ts for the canonical (browser/server)
// copy of the constants duplicated below.
//
// Node 24 runs this directly (type stripping) — erasable TS syntax only,
// node: builtins only, no npm dependencies (this is why the constants below are
// copied rather than imported - see scripts/install.ts's header comment).
//
// Usage:
//   node scripts/pair.ts [--config-dir <path>] [--url <server url>] [--web-url <web url>]
//                         [--label <text>] [--no-squatter-check]
//
// NOTE on --label: this script only mints a pairing code (POST /api/auth/pairing-codes), which
// per its contract (PairingCodeRequestSchema in packages/shared/src/auth.ts) takes no label - it
// is a strictObject of {challengeId, proof} and rejects unknown keys. The label is attached later,
// when the code is REDEEMED for a session (POST /api/auth/pair {code, label}), which happens in the
// browser when the user opens the printed URL. So --label here is accepted for convenience but is
// never sent to the server; main() prints a reminder to enter it in the browser instead.

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  mintPairingCode,
  pairFailureHint,
  readRunnerToken,
  resolveSetupPaths,
  validateUrl,
} from '../packages/setup/src/index.ts';

// The pairing flow itself lives in packages/setup (imported by RELATIVE path, because node refuses to
// strip types under node_modules); re-exported for the tests.
export { isValidRunnerToken, mintPairingCode, pairFailureHint, readRunnerToken } from '../packages/setup/src/index.ts';
export type { PairResult } from '../packages/setup/src/index.ts';

// POSIX keeps ~/.config/tagconn (where the sh hook looks); win32 uses %APPDATA%\tagconn.
const DEFAULT_CONFIG_DIR = resolveSetupPaths({ legacyPosixConfig: true }).config;

export interface Args {
  configDir: string;
  url: string;
  webUrl: string;
  label?: string;
  noSquatterCheck: boolean;
  help: boolean;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = {
    configDir: process.env.TAGCONN_CONFIG_DIR ? resolve(process.env.TAGCONN_CONFIG_DIR) : DEFAULT_CONFIG_DIR,
    url: validateUrl(process.env.OFFICE_URL || 'http://127.0.0.1:4317'),
    webUrl: validateUrl(process.env.OFFICE_WEB_URL || 'http://localhost:4318'),
    label: undefined,
    noSquatterCheck: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config-dir') args.configDir = resolve(argv[++i] ?? '');
    else if (a === '--url') args.url = validateUrl(argv[++i] ?? args.url);
    else if (a === '--web-url') args.webUrl = validateUrl(argv[++i] ?? args.webUrl);
    else if (a === '--label') args.label = argv[++i];
    else if (a === '--no-squatter-check') args.noSquatterCheck = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else {
      console.error(`Unknown argument: ${a}`);
      args.help = true;
    }
  }
  return args;
}

function printHelp(): void {
  console.log(`tagconn pair - mint a browser pairing code

Usage:
  node scripts/pair.ts [options]

Options:
  --config-dir <path>    Dir holding runner.json (default: $TAGCONN_CONFIG_DIR or ~/.config/tagconn).
  --url <server url>     Office server URL (default: http://127.0.0.1:4317).
  --web-url <web url>    Browser-facing origin, for the :4318 squatter check
                         (default: http://localhost:4318).
  --label <text>         Accepted for convenience but NOT sent when minting the code (the
                         pairing-codes endpoint takes no label); enter it in the browser's
                         pairing form when you redeem the code instead.
  --no-squatter-check    Skip comparing the web origin's instanceId to the server's.
  --help                 Show this help.
`);
}

export async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  if (args.label) {
    // See the header comment: --label is not sent to /api/auth/pairing-codes (it takes no
    // label). It is entered in the browser's pairing form instead, when the code is redeemed.
    console.log(`Note: --label is not sent when minting a code; enter "${args.label}" in the browser's pairing form.`);
  }

  const token = readRunnerToken(args.configDir);
  const result = await mintPairingCode(args.url, args.webUrl, token, args.noSquatterCheck);

  if (result.squatterCheckPassed === false) {
    // SC4 M3: fail closed - never print the code/URL when the web origin doesn't check out.
    // The code the server minted is now spent (single use), but that's a smaller cost than
    // handing the user a link that might not be their own server.
    console.error(
      `REFUSING to print the pairing code: ${args.webUrl} does not look like the same server as ${args.url} ` +
        '(instanceId/version mismatch, or the pairing URL points at a different origin). Something else may be ' +
        'answering on the web port. Re-run with --no-squatter-check to override if you are certain this is safe. ' +
        '(See docs/design/runner-and-helpdesk.md §5.2, T9.)',
    );
    process.exitCode = 1;
    return;
  }
  if (result.squatterCheckPassed === undefined && !args.noSquatterCheck) {
    console.warn(`Could not fully verify ${args.webUrl} matches the server (a health endpoint was unreachable).`);
  }

  console.log(`Pairing code: ${result.code}`);
  console.log(`Open: ${result.url}`);
  const expiresInSec = Math.max(0, Math.round((result.expiresAt - Date.now()) / 1000));
  console.log(`Expires in ${expiresInSec}s.`);
}

// Only run when this file is the entry point (not when imported by tests).
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err: unknown) => {
    const message = (err as Error).message;
    console.error(`tagconn pair failed: ${message}`);
    const hint = pairFailureHint(message);
    if (hint) console.error(hint);
    process.exitCode = 1;
  });
}
