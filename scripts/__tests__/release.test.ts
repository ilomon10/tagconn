import { describe, expect, it } from 'vitest';
import { cutChangelog, EXTRA_VERSION_FILES, nextVersion } from '../release.ts';

describe('nextVersion', () => {
  it('bumps patch, minor and major', () => {
    expect(nextVersion('0.1.2', 'patch')).toBe('0.1.3');
    expect(nextVersion('0.1.2', 'minor')).toBe('0.2.0');
    expect(nextVersion('0.1.2', 'major')).toBe('1.0.0');
  });
  it('accepts an explicit version and rejects junk', () => {
    expect(nextVersion('0.1.2', '2.0.0')).toBe('2.0.0');
    expect(() => nextVersion('0.1.2', 'huge')).toThrow();
  });
});

describe('cutChangelog', () => {
  const repo = 'https://github.com/o/r';
  const base = `# Changelog\n\n## [Unreleased]\n\n### Added\n- New thing\n\n## [0.1.0] - 2026-01-01\n\n- First\n\n[Unreleased]: ${repo}/compare/v0.1.0...HEAD\n[0.1.0]: ${repo}/releases/tag/v0.1.0\n`;

  it('moves Unreleased notes under the new version and refreshes links', () => {
    const out = cutChangelog(base, '0.2.0', '2026-02-02', repo);
    expect(out).toContain('## [Unreleased]\n\n## [0.2.0] - 2026-02-02\n\n### Added\n- New thing');
    expect(out).toContain('## [0.1.0] - 2026-01-01');
    expect(out).toContain(`[Unreleased]: ${repo}/compare/v0.2.0...HEAD`);
    expect(out).toContain(`[0.2.0]: ${repo}/compare/v0.1.0...v0.2.0`);
    expect(out).toContain(`[0.1.0]: ${repo}/releases/tag/v0.1.0`);
    expect(out.match(/\[Unreleased\]:/g)).toHaveLength(1);
    expect(out.trimEnd().split('\n').slice(-3)).toEqual([
      `[Unreleased]: ${repo}/compare/v0.2.0...HEAD`,
      `[0.2.0]: ${repo}/compare/v0.1.0...v0.2.0`,
      `[0.1.0]: ${repo}/releases/tag/v0.1.0`,
    ]);
  });

  it('refuses an empty Unreleased section', () => {
    const empty = `# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-01-01\n\n- First\n`;
    expect(() => cutChangelog(empty, '0.2.0', '2026-02-02', repo)).toThrow(/empty/);
  });
});

describe('desktop version files', () => {
  const bump = (path: string, text: string) => EXTRA_VERSION_FILES.find((f) => f.path.endsWith(path))!.bump(text, '1.2.3');
  it('bumps tauri.conf.json, Cargo.toml [package] and the Cargo.lock entry only', () => {
    expect(bump('tauri.conf.json', '{\n  "productName": "tagconn",\n  "version": "0.4.1"\n}')).toContain('"version": "1.2.3"');
    const toml = bump('Cargo.toml', '[package]\nname = "tagconn-desktop"\nversion = "0.4.1"\n\n[dependencies]\nserde = { version = "1" }\n');
    expect(toml).toContain('version = "1.2.3"');
    expect(toml).toContain('serde = { version = "1" }');
    const lock = bump('Cargo.lock', '[[package]]\nname = "serde"\nversion = "1.0.0"\n\n[[package]]\nname = "tagconn-desktop"\nversion = "0.4.1"\n');
    expect(lock).toContain('name = "serde"\nversion = "1.0.0"');
    expect(lock).toContain('name = "tagconn-desktop"\nversion = "1.2.3"');
  });
});

