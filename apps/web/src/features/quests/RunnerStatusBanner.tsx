import type { ReactNode } from 'react';
import { useOfficeStore } from '../../stores/officeStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useRunsStore } from '../../stores/runsStore';
import { cx } from '../../components/ui';

/**
 * Runner status banner (docs/design/runner-and-helpdesk.md section 3): "connected/capabilities/offline
 * → guidance; disabled → guidance". Three states, checked in order — a disabled runner is shown even
 * if a stale `runnerStatus` happens to say connected (settings won the last time it changed), and a
 * missing/failed capability outranks a plain "connected" banner because it means quests will still be
 * refused despite the green dot.
 */

const TONE_CLASS = {
  ok: 'border-emerald-700 bg-emerald-950/40 text-emerald-100',
  warn: 'border-amber-700 bg-amber-950/40 text-amber-100',
  error: 'border-red-800 bg-red-950/40 text-red-100',
} as const;

function Banner({ tone, children }: { tone: keyof typeof TONE_CLASS; children: ReactNode }) {
  return <div className={cx('rounded-md border px-3 py-2 text-xs leading-relaxed', TONE_CLASS[tone])}>{children}</div>;
}

export function RunnerStatusBanner() {
  const demo = useOfficeStore((s) => s.connection === 'demo');
  const enabled = useSettingsStore((s) => s.settings.runner.enabled);
  const status = useRunsStore((s) => s.runnerStatus);

  if (!demo && !enabled) {
    return (
      <Banner tone="warn">
        Runner disabled — enable it with <code className="font-pixel">OFFICE_RUNNER__ENABLED=true</code> (the installer does
        this when you pass <code className="font-pixel">--allow-dir</code>).
      </Banner>
    );
  }

  if (!status || !status.connected || !status.verified) {
    return (
      <Banner tone="warn">
        No runner connected — run <code className="font-pixel">pnpm office:runner</code> on the host.
      </Banner>
    );
  }

  const caps = status.capabilities;
  if (caps && (!caps.settingSources || !caps.strictMcpConfig || !caps.permissionPrompts)) {
    return (
      <Banner tone="error">
        The connected runner is missing a Claude CLI capability every run needs (--setting-sources / --strict-mcp-config /
        --permission-prompts). Update Claude Code on the host and restart the runner.
      </Banner>
    );
  }

  return (
    <Banner tone="ok">
      Runner connected — {status.activeRuns} active, {status.queuedRuns} queued, up to {status.maxConcurrent} at once.
      {caps && !caps.systemdScope && ' No systemd scope on this host: modes that can run shell commands (auto, bypassPermissions) are refused.'}
    </Banner>
  );
}
