import { describe, expect, it } from 'vitest';
import { buildQuestArgv, buildReceptionistArgv } from '../../src/argv.js';

describe('buildQuestArgv', () => {
  const base = {
    claudePath: 'claude',
    model: 'sonnet' as const,
    mode: 'acceptEdits' as const,
    allowedTools: ['Read', 'Edit'],
    disallowedTools: ['Edit(.claude/**)', 'Write(.claude/**)'],
    toolSet: ['Read', 'Grep', 'Glob', 'TodoWrite', 'Edit'],
    partialMessages: true,
    stdinPrompt: true,
    prompt: 'hello world',
  };

  it('always includes --setting-sources=user and --strict-mcp-config', () => {
    const argv = buildQuestArgv(base);
    expect(argv).toContain('--setting-sources=user');
    expect(argv).toContain('--strict-mcp-config');
  });

  it('always includes --permission-prompts=none', () => {
    expect(buildQuestArgv(base)).toContain('--permission-prompts=none');
  });

  it('always includes an exact --tools list (H2: bounds the built-in tool set, not just allow/deny)', () => {
    const argv = buildQuestArgv(base);
    expect(argv).toContain(`--tools=${base.toolSet.join(',')}`);
  });

  it('uses --flag=value form for every value flag (never a separate argv token)', () => {
    const argv = buildQuestArgv({ ...base, maxTurns: 5, resumeSessionId: 'sess-1', questMcpConfigPath: '/mcp.json' });
    for (const flag of ['--permission-mode', '--model', '--max-turns', '--resume', '--tools', '--allowedTools', '--disallowedTools', '--mcp-config']) {
      const token = argv.find((a) => a.startsWith(flag));
      expect(token, `expected an argv token starting with ${flag}`).toMatch(new RegExp(`^${flag}=`));
    }
  });

  it('puts the prompt on stdin when supported, never on argv', () => {
    const argv = buildQuestArgv(base);
    expect(argv).not.toContain('hello world');
    expect(argv).not.toContain('--');
  });

  it('falls back to `-- <prompt>` only when stdin is not supported', () => {
    const argv = buildQuestArgv({ ...base, stdinPrompt: false });
    expect(argv.at(-2)).toBe('--');
    expect(argv.at(-1)).toBe('hello world');
  });

  it('a flag-looking stdin prompt does not change the argv (V9): the mode flag is unaffected either way', () => {
    const argvA = buildQuestArgv({ ...base, prompt: '--dangerously-skip-permissions hi' });
    const argvB = buildQuestArgv(base);
    // only the trailing prompt token (fallback path) would differ; on stdin, argv is identical.
    expect(argvA.filter((a) => a.startsWith('--permission-mode'))).toEqual(argvB.filter((a) => a.startsWith('--permission-mode')));
  });

  it('includes --resume=<sid> only when a resumeSessionId is given', () => {
    expect(buildQuestArgv(base).some((a) => a.startsWith('--resume='))).toBe(false);
    expect(buildQuestArgv({ ...base, resumeSessionId: 'sess-123' })).toContain('--resume=sess-123');
  });

  it('includes --allowedTools and --disallowedTools as comma-joined rules', () => {
    const argv = buildQuestArgv(base);
    expect(argv).toContain('--allowedTools=Read,Edit');
    expect(argv).toContain('--disallowedTools=Edit(.claude/**),Write(.claude/**)');
  });

  it('includes --mcp-config only when questMcpConfigPath is set', () => {
    expect(buildQuestArgv(base).some((a) => a.startsWith('--mcp-config='))).toBe(false);
    expect(buildQuestArgv({ ...base, questMcpConfigPath: '/etc/tagconn/quest-mcp.json' })).toContain('--mcp-config=/etc/tagconn/quest-mcp.json');
  });
});

describe('buildReceptionistArgv', () => {
  const base = {
    claudePath: 'claude',
    scope: 'project' as const,
    model: 'sonnet' as const,
    maxTurns: 20,
    webSearch: true,
    webFetchDomains: [] as string[],
    sandboxed: true,
    safeMode: false,
    extraDisallowedTools: [] as string[],
    stdinPrompt: true,
    prompt: 'what does this repo do?',
  };

  it('project scope: always --restricted, never WebFetch even if requested', () => {
    const { argv, restricted, toolSet } = buildReceptionistArgv(base);
    expect(restricted).toBe(true);
    expect(argv).toContain('--restricted');
    expect(toolSet).not.toContain('WebFetch');
  });

  it('project scope tool set equals the exact --tools string (L5 requires equality)', () => {
    const { argv, toolSet } = buildReceptionistArgv(base);
    expect([...toolSet].sort()).toEqual(['Glob', 'Grep', 'Read', 'WebSearch'].sort());
    expect(argv).toContain(`--tools=${toolSet.join(',')}`);
  });

  it('general scope without WebFetch domains stays --restricted and adds --add-dir', () => {
    const result = buildReceptionistArgv({ ...base, scope: 'general', addDirDocs: '/state/receptionist-docs' });
    expect(result.restricted).toBe(true);
    expect(result.argv).toContain('--add-dir=/state/receptionist-docs');
  });

  it('general scope WITH a webfetch allowlist and bwrap drops --restricted and expands WebFetch(domain:x)', () => {
    const result = buildReceptionistArgv({ ...base, scope: 'general', webFetchDomains: ['a.org', 'b.dev'], sandboxed: true, addDirDocs: '/docs' });
    expect(result.restricted).toBe(false);
    expect(result.webFetchActive).toBe(true);
    expect(result.argv.join(' ')).not.toContain('--restricted');
    const allowedFlag = result.argv.find((a) => a.startsWith('--allowedTools='));
    expect(allowedFlag).toContain('WebFetch(domain:a.org)');
    expect(allowedFlag).toContain('WebFetch(domain:b.dev)');
    expect(allowedFlag).not.toMatch(/(?<!\()WebFetch(?!\()/); // never a bare "WebFetch" allow rule
  });

  it('general scope WebFetch requested but NOT sandboxed drops WebFetch entirely (falls back to default general)', () => {
    const result = buildReceptionistArgv({ ...base, scope: 'general', webFetchDomains: ['a.org'], sandboxed: false, addDirDocs: '/docs' });
    expect(result.webFetchActive).toBe(false);
    expect(result.restricted).toBe(true);
    expect(result.toolSet).not.toContain('WebFetch');
  });

  it('project scope --safe-mode only when safeMode is true', () => {
    expect(buildReceptionistArgv(base).argv).not.toContain('--safe-mode');
    expect(buildReceptionistArgv({ ...base, safeMode: true }).argv).toContain('--safe-mode');
  });

  it('general scope ignores safeMode (V5 trade-off is project-scope only)', () => {
    expect(buildReceptionistArgv({ ...base, scope: 'general', safeMode: true, addDirDocs: '/docs' }).argv).not.toContain('--safe-mode');
  });

  it('disallowedTools always includes the backstop denies (Bash, Write, loopback WebFetch, secret globs)', () => {
    const argv = buildReceptionistArgv(base).argv;
    const denyFlag = argv.find((a) => a.startsWith('--disallowedTools='));
    expect(denyFlag).toContain('Bash');
    expect(denyFlag).toContain('Write');
    expect(denyFlag).toContain('WebFetch(domain:127.0.0.1)');
    expect(denyFlag).toContain('Read(~/.ssh/**)');
  });

  it('always plan mode, --disable-slash-commands, and the constant system prompt', () => {
    const argv = buildReceptionistArgv(base).argv;
    expect(argv).toContain('--permission-mode=plan');
    expect(argv).toContain('--disable-slash-commands');
    expect(argv.some((a) => a.startsWith('--append-system-prompt='))).toBe(true);
  });

  it('always --setting-sources=user, --strict-mcp-config with an empty mcp config, --permission-prompts=none', () => {
    const argv = buildReceptionistArgv(base).argv;
    expect(argv).toContain('--setting-sources=user');
    expect(argv).toContain('--strict-mcp-config');
    expect(argv).toContain('--mcp-config={"mcpServers":{}}');
    expect(argv).toContain('--permission-prompts=none');
  });

  it('extraDisallowedTools (server extra denies / extraDenyReadGlobs) are appended, never replacing the constants', () => {
    const argv = buildReceptionistArgv({ ...base, extraDisallowedTools: ['Read(secret/**)'] }).argv;
    const denyFlag = argv.find((a) => a.startsWith('--disallowedTools='));
    expect(denyFlag).toContain('Read(secret/**)');
    expect(denyFlag).toContain('Bash'); // constants still present
  });
});
