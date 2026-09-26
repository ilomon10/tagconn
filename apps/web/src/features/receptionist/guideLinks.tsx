import { useState } from 'react';

/** Shared doc links + a copy-command button for the Receptionist panel's empty/gate states, kept in
 *  one place so `ReceptionistPanel.tsx` and `ConversationSidebar.tsx` don't drift on the URL or the
 *  markup. Mirrors `features/quests/runnerBannerState.ts`'s `GuideLink`/`CopyCommand` — duplicated
 *  rather than imported across features, same convention as `scope.ts`'s `isProjectDirAllowed` vs
 *  `modes.ts`'s copy of the same check. */
export const RECEPTIONIST_GUIDE_URL = 'https://github.com/ilomon10/tagconn/blob/main/docs/guide/receptionist.md';
/** Runner-offline messaging points at the runner guide (where `pnpm office:runner` is documented),
 *  not the Receptionist guide. */
export const RUNNER_AND_QUESTS_GUIDE_URL = 'https://github.com/ilomon10/tagconn/blob/main/docs/guide/runner-and-quests.md';

const RUNNER_START_COMMAND = 'pnpm office:runner';

export function GuideLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="underline hover:no-underline">
      {children}
    </a>
  );
}

/** Shows the exact host command plus a one-click copy — `navigator.clipboard` isn't available in every
 *  context (insecure origin, permissions), so a failed copy just leaves the command visible as text. */
export function CopyRunnerCommand() {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(RUNNER_START_COMMAND);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable — the command is still right there to copy by hand.
    }
  };

  return (
    <span className="inline-flex items-center gap-1">
      <code className="font-pixel">{RUNNER_START_COMMAND}</code>
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
