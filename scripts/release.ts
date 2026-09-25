// Cut a release: bump every workspace package.json (lockstep SemVer), move the CHANGELOG
// "Unreleased" section under the new version, commit and create an annotated tag. Never pushes.
//
//   pnpm release <patch|minor|major|X.Y.Z> [--dry-run]
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

export function nextVersion(current: string, bump: string): string {
  if (SEMVER.test(bump)) return bump;
  const m = SEMVER.exec(current);
  if (!m) throw new Error(`current version "${current}" is not X.Y.Z`);
  const [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (bump === 'major') return `${maj + 1}.0.0`;
  if (bump === 'minor') return `${maj}.${min + 1}.0`;
  if (bump === 'patch') return `${maj}.${min}.${pat + 1}`;
  throw new Error(`unknown bump "${bump}" (use patch, minor, major or X.Y.Z)`);
}

/** Moves the body of "## [Unreleased]" under "## [version] - date" and refreshes compare links. */
export function cutChangelog(text: string, version: string, date: string, repoUrl: string): string {
  const head = '## [Unreleased]';
  const start = text.indexOf(head);
  if (start < 0) throw new Error('CHANGELOG.md has no "## [Unreleased]" section');
  const bodyStart = start + head.length;
  const nextHeading = text.indexOf('\n## [', bodyStart);
  const linksStart = text.search(/\n\[Unreleased\]:/);
  const bodyEnd = nextHeading >= 0 ? nextHeading : linksStart >= 0 ? linksStart : text.length;
  const body = text.slice(bodyStart, bodyEnd).trim();
  if (!body) throw new Error('the Unreleased section is empty; nothing to release');

  const out = `${text.slice(0, bodyStart)}\n\n## [${version}] - ${date}\n\n${body}\n${text.slice(bodyEnd)}`;
  const prev = /\n## \[(\d+\.\d+\.\d+)\]/.exec(text.slice(bodyEnd))?.[1];
  // Link references live in one block at the end: Unreleased first, then versions newest first.
  const isLinkRef = (line: string) => /^\[[^\]]+\]:\s/.test(line);
  const lines = out.trimEnd().split('\n');
  const oldLinks = lines.filter((l) => isLinkRef(l) && !l.startsWith('[Unreleased]:'));
  const content = lines.filter((l) => !isLinkRef(l)).join('\n').trimEnd();
  const links = [
    `[Unreleased]: ${repoUrl}/compare/v${version}...HEAD`,
    prev ? `[${version}]: ${repoUrl}/compare/v${prev}...v${version}` : `[${version}]: ${repoUrl}/releases/tag/v${version}`,
    ...oldLinks,
  ].join('\n');
  return `${content}\n\n${links}\n`.replace(/\n{3,}/g, '\n\n');
}

function packageJsonPaths(): string[] {
  const paths = [join(ROOT, 'package.json')];
  for (const group of ['apps', 'packages']) {
    const dir = join(ROOT, group);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name, 'package.json');
      if (existsSync(p)) paths.push(p);
    }
  }
  return paths;
}

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

export function main(argv: string[]): void {
  const dryRun = argv.includes('--dry-run');
  const bump = argv.find((a) => !a.startsWith('--'));
  if (!bump || argv.includes('--help')) {
    console.log('usage: pnpm release <patch|minor|major|X.Y.Z> [--dry-run]');
    return;
  }
  if (!dryRun && git(['status', '--porcelain'])) throw new Error('working tree is not clean; commit or stash first');

  const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string; repository?: { url?: string } };
  const version = nextVersion(rootPkg.version, bump);
  if (!dryRun && git(['tag', '--list', `v${version}`])) throw new Error(`tag v${version} already exists`);
  const repoUrl = (rootPkg.repository?.url ?? '').replace(/^git\+/, '').replace(/\.git$/, '');
  const date = new Date().toISOString().slice(0, 10);

  const changelogPath = join(ROOT, 'CHANGELOG.md');
  const changelog = cutChangelog(readFileSync(changelogPath, 'utf8'), version, date, repoUrl);
  const files = packageJsonPaths();
  console.log(`release v${rootPkg.version} -> v${version}${dryRun ? ' (dry run)' : ''}`);
  if (dryRun) {
    files.forEach((f) => console.log(`  would bump ${f.slice(ROOT.length + 1)}`));
    return;
  }

  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    writeFileSync(file, text.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`));
  }
  writeFileSync(changelogPath, changelog);
  git(['add', 'CHANGELOG.md', ...files.map((f) => f.slice(ROOT.length + 1))]);
  git(['commit', '-m', `chore(release): v${version}`]);
  git(['tag', '-a', `v${version}`, '-m', `v${version}`]);
  console.log(`tagged v${version}. Publish with: git push --follow-tags`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`release failed: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}
