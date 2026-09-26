import { useState, type ReactNode } from 'react';
import { useOfficeStore } from '../../stores/officeStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useRunsStore } from '../../stores/runsStore';
import { cx } from '../../components/ui';
import { RUNNER_AND_QUESTS_GUIDE_URL, RUNNER_START_COMMAND, runnerBannerState } from './runnerBannerState';

/**
 * Runner status banner (docs/design/runner-and-helpdesk.md section 3: "connected/capabilities/offline
 * → guidance; disabled → guidance"). The precedence itself (a disabled runner outranks a stale
 * "connected" status, a missing capability outranks a plain "connected" banner) lives in the pure
 * `runnerBannerState` so it's unit-tested without rendering anything; this component only renders
 * whatever state comes back, plus a copy button for the exact command to run and a link to the guide.
 */

const TONE_CLASS = {
  ok: 'border-emerald-700 bg-emerald-950/40 text-emerald-100',
  warn: 'border-amber-700 bg-amber-950/40 text-amber-100',
  error: 'border-red-800 bg-red-950/40 text-red-100',
} as const;

function Banner({ tone, children }: { tone: keyof typeof TONE_CLASS; children: ReactNode }) {
  return <div className={cx('flex flex-wrap items-center gap-x-1.5 gap-y-1 rounded-md border px-3 py-2 text-xs leading-relaxed', TONE_CLASS[tone])}>{children}</div>;
}

function GuideLink() {
  return (
    <a href={RUNNER_AND_QUESTS_GUIDE_URL} target="_blank" rel="noopener noreferrer" className="underline hover:no-underline">
      Runner &amp; quests guide
    </a>
  );
}

/** Shows the exact host command plus a one-click copy — `navigator.clipboard` isn't available in every
 *  context (insecure origin, permissions), so a failed copy just leaves the command visible as text. */
function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable — the command is still right there to copy by hand.
    }
  };

  return (
    <span className="inline-flex items-center gap-1">
      <code className="font-pixel">{command}</code>
      <button
        type="button"
        onClick={() => void copy()}
        className="motion-safe:transition rounded bg-ink-700 px-1.5 py-0.5 text-[10px] text-ink-200 hover:bg-ink-600"
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </span>
  );
}

export function RunnerStatusBanner() {
  const demo = useOfficeStore((s) => s.connection === 'demo');
  const enabled = useSettingsStore((s) => s.settings.runner.enabled);
  const status = useRunsStore((s) => s.runnerStatus);
  const state = runnerBannerState({ demo, enabled, status });

  switch (state.kind) {
    case 'disabled':
      return (
        <Banner tone="warn">
          <span>
            Runner disabled — enable it with <code className="font-pixel">OFFICE_RUNNER__ENABLED=true</code> (the installer
            does this when you pass <code className="font-pixel">--allow-dir</code>).
          </span>
          <GuideLink />
        </Banner>
      );
    case 'offline':
      return (
        <Banner tone="warn">
          <span>No runner connected — run</span>
          <CopyCommand command={RUNNER_START_COMMAND} />
          <span>on the host.</span>
          <GuideLink />
        </Banner>
      );
    case 'capability_missing':
      return (
        <Banner tone="error">
          <span>
            The connected runner is missing a Claude CLI capability every run needs (--setting-sources /
            --strict-mcp-config / --permission-prompts). Update Claude Code on the host and restart the runner.
          </span>
          <GuideLink />
        </Banner>
      );
    case 'ok':
      return (
        <Banner tone="ok">
          <span>
            Runner connected — {state.activeRuns} active, {state.queuedRuns} queued, up to {state.maxConcurrent} at once.
            {state.noSystemdScope && ' No systemd scope on this host: modes that can run shell commands (auto, bypassPermissions) are refused.'}
          </span>
        </Banner>
      );
  }
}
