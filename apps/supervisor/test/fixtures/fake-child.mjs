// A tiny stand-in for the server/runner in service-manager tests.
// usage: node fake-child.mjs <mode> [arg]
//   exit <code> [delayMs]  exit after a delay      hang            run until killed
//   print                  print lines, then hang  ignoreterm      ignore SIGTERM (needs a tree kill)
//   tree                   spawn a grandchild (same process group), print its pid, then hang
import { spawn } from 'node:child_process';

const [mode = 'hang', arg] = process.argv.slice(2);
const hang = () => setInterval(() => {}, 1000);

if (mode === 'exit') {
  console.error('boom: something failed');
  setTimeout(() => process.exit(Number(arg ?? 1)), Number(process.argv[4] ?? 0));
} else if (mode === 'print') {
  console.log('hello from the fake child');
  process.stdout.write('partial');
  process.stderr.write('warn: token=abcdef1234567890abcdef1234567890abcdef\n');
  setTimeout(() => process.stdout.write(' line\n'), 30);
  hang();
} else if (mode === 'ignoreterm') {
  process.on('SIGTERM', () => console.log('ignoring SIGTERM'));
  console.log('ready');
  hang();
} else if (mode === 'tree') {
  const g = spawn(process.execPath, [new URL(import.meta.url).pathname, 'hang'], { stdio: 'ignore' });
  console.log(`grandchild ${g.pid}`);
  hang();
} else {
  console.log('ready');
  hang();
}
