import { describe, expect, it } from 'vitest';
import { cutChangelog, nextVersion } from '../release.ts';

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
  });

  it('refuses an empty Unreleased section', () => {
    const empty = `# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-01-01\n\n- First\n`;
    expect(() => cutChangelog(empty, '0.2.0', '2026-02-02', repo)).toThrow(/empty/);
  });
});
