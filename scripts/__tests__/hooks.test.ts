import { describe, expect, it } from 'vitest';
import { installHooks, isOurCommand, ourCommand, type SettingsJson, uninstallHooks } from '../install.ts';

const HOOK_EVENT_COUNT = 11; // SessionStart, SessionEnd, UserPromptSubmit, Pre/PostToolUse(Failure),
// SubagentStart/Stop, Stop, Notification, PreCompact - see HOOK_EVENTS in install.ts.

// isOurCommand's plain-quoted-path form only matches a path containing
// "tagconn/office-hook.sh" (see HOOK_MARKER in install.ts), so fixture paths
// for the default (isDefaultConfigDir=true) form must include it.
const DEFAULT_HOOK_SCRIPT = '/home/me/.config/tagconn/office-hook.sh';
const DEFAULT_CURL_CONF = '/home/me/.config/tagconn/curl.conf';

describe('isOurCommand', () => {
  it('matches the default plain double-quoted path form', () => {
    expect(isOurCommand('"/home/me/.config/tagconn/office-hook.sh"')).toBe(true);
  });

  it('matches the non-default TAGCONN_CURL_CONF form', () => {
    expect(isOurCommand(`TAGCONN_CURL_CONF='/tmp/x/curl.conf' '/tmp/x/office-hook.sh'`)).toBe(true);
  });

  it('does not match an unrelated command', () => {
    expect(isOurCommand('"/usr/local/bin/some-other-hook.sh"')).toBe(false);
    expect(isOurCommand(undefined)).toBe(false);
    expect(isOurCommand(42)).toBe(false);
  });
});

describe('ourCommand', () => {
  it('renders a plain quoted path for the default config dir', () => {
    expect(ourCommand('/home/me/.config/tagconn/office-hook.sh', '/home/me/.config/tagconn/curl.conf', true)).toBe(
      '"/home/me/.config/tagconn/office-hook.sh"',
    );
  });

  it('renders TAGCONN_CURL_CONF=... form for a non-default config dir', () => {
    expect(ourCommand('/tmp/x/office-hook.sh', '/tmp/x/curl.conf', false)).toBe(
      `TAGCONN_CURL_CONF='/tmp/x/curl.conf' '/tmp/x/office-hook.sh'`,
    );
  });
});

describe('installHooks / uninstallHooks', () => {
  it('adds one of our hooks per event on a fresh settings object', () => {
    const settings: SettingsJson = {};
    const { added, skipped } = installHooks(settings, DEFAULT_HOOK_SCRIPT, DEFAULT_CURL_CONF, true);
    expect(added).toBe(HOOK_EVENT_COUNT);
    expect(skipped).toBe(0);
    expect(Object.keys(settings.hooks ?? {})).toHaveLength(HOOK_EVENT_COUNT);
  });

  it('is idempotent: installing twice adds nothing the second time', () => {
    const settings: SettingsJson = {};
    installHooks(settings, DEFAULT_HOOK_SCRIPT, DEFAULT_CURL_CONF, true);
    const second = installHooks(settings, DEFAULT_HOOK_SCRIPT, DEFAULT_CURL_CONF, true);
    expect(second.added).toBe(0);
    expect(second.skipped).toBe(HOOK_EVENT_COUNT);
    // And no event has more than one of our hook entries.
    for (const groups of Object.values(settings.hooks ?? {})) {
      const ourCount = groups.flatMap((g) => g.hooks ?? []).filter((h) => isOurCommand(h.command)).length;
      expect(ourCount).toBe(1);
    }
  });

  it('preserves unrelated hooks already in the same matcher group, and unrelated top-level keys', () => {
    const settings: SettingsJson = {
      someOtherKey: { keep: 'me' },
      hooks: {
        PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: '"/opt/unrelated-hook.sh"' }] }],
        SessionStart: [{ hooks: [{ type: 'command', command: '"/opt/another-unrelated.sh"' }] }],
      },
    };
    installHooks(settings, DEFAULT_HOOK_SCRIPT, DEFAULT_CURL_CONF, true);

    expect(settings.someOtherKey).toEqual({ keep: 'me' });
    const preToolUseHooks = settings.hooks?.PreToolUse?.find((g) => g.matcher === '*')?.hooks ?? [];
    expect(preToolUseHooks.some((h) => h.command === '"/opt/unrelated-hook.sh"')).toBe(true);
    expect(preToolUseHooks.some((h) => isOurCommand(h.command))).toBe(true);
    const sessionStartHooks = settings.hooks?.SessionStart?.[0]?.hooks ?? [];
    expect(sessionStartHooks.some((h) => h.command === '"/opt/another-unrelated.sh"')).toBe(true);
  });

  it('appends to an existing "*" matcher group for matcher events instead of creating a second one', () => {
    const settings: SettingsJson = {
      hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: '"/opt/unrelated-hook.sh"' }] }] },
    };
    installHooks(settings, DEFAULT_HOOK_SCRIPT, DEFAULT_CURL_CONF, true);
    const groups = settings.hooks?.PreToolUse ?? [];
    expect(groups).toHaveLength(1);
    expect(groups[0]?.hooks).toHaveLength(2);
  });

  it('removes only our hooks in both command forms, leaving unrelated hooks and empty groups cleaned up', () => {
    const settings: SettingsJson = {
      hooks: {
        PreToolUse: [
          {
            matcher: '*',
            hooks: [
              { type: 'command', command: '"/opt/unrelated-hook.sh"' },
              { type: 'command', command: '"/home/me/.config/tagconn/office-hook.sh"' },
            ],
          },
        ],
        SessionStart: [{ hooks: [{ type: 'command', command: `TAGCONN_CURL_CONF='/tmp/x/curl.conf' '/tmp/x/office-hook.sh'` }] }],
        SessionEnd: [{ hooks: [{ type: 'command', command: '"/opt/only-unrelated.sh"' }] }],
      },
    };
    const { removed } = uninstallHooks(settings);
    expect(removed).toBe(2);

    const preToolUseHooks = settings.hooks?.PreToolUse?.[0]?.hooks ?? [];
    expect(preToolUseHooks).toHaveLength(1);
    expect(preToolUseHooks[0]?.command).toBe('"/opt/unrelated-hook.sh"');

    // SessionStart had only our hook, and its group + event key are dropped entirely.
    expect(settings.hooks?.SessionStart).toBeUndefined();

    // SessionEnd was untouched.
    expect(settings.hooks?.SessionEnd?.[0]?.hooks?.[0]?.command).toBe('"/opt/only-unrelated.sh"');
  });

  it('drops the whole "hooks" key when nothing is left after uninstall', () => {
    const settings: SettingsJson = {
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: '"/home/me/.config/tagconn/office-hook.sh"' }] }] },
    };
    uninstallHooks(settings);
    expect(settings.hooks).toBeUndefined();
  });
});
