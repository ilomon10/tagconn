import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReceptionistScope, RunnerStatus } from '@tagconn/shared';
import { useOfficeStore } from '../../stores/officeStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useAuthStore } from '../../stores/authStore';
import { conversationList, registerReceptionistEvents, useReceptionistStore } from '../../stores/receptionistStore';
import { getSocket } from '../../lib/socket';
import { isDemo } from '../../lib/connection';
import { isMultiverseFloor } from '../../lib/floors';
import { useModalFocus } from '../../lib/useModalFocus';
import { Button, cx } from '../../components/ui';
import { useReceptionistUiStore } from './uiStore';
import { AckError, AckTimeoutError, receptionistApi } from './receptionistApi';
import { DEMO_CONVERSATION, DEMO_CONVERSATION_ID, DEMO_MESSAGES } from './demoData';
import { ConversationSidebar } from './ConversationSidebar';
import { MessageThread } from './MessageThread';
import { receptionistPanelGate, receptionistSendGate } from './gate';
import { isWindowsRunner, WINDOWS_LIMITS_URL, WINDOWS_NOTE } from '../quests/platform';
import { CopyRunnerCommand, GuideLink, RECEPTIONIST_GUIDE_URL, RUNNER_AND_QUESTS_GUIDE_URL } from './guideLinks';

function errorMessage(err: unknown): string {
  if (err instanceof AckTimeoutError) return 'Pair this browser to make changes';
  if (err instanceof AckError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

/**
 * The Receptionist chat panel (W3, docs/design/runner-and-helpdesk.md §4.1): a read-only help desk,
 * one conversation at a time, with a scope choice, streaming replies and tool chips. Mounted once
 * from `app/App.tsx`, gated on `useReceptionistUiStore`'s `open`; opened via the "Receptionist" button
 * in `app/TopBar.tsx`, which already runs it through `useRequireAdmin`'s `guard`.
 */
export function ReceptionistPanel() {
  const open = useReceptionistUiStore((s) => s.open);
  const closePanel = useReceptionistUiStore((s) => s.closePanel);
  const activeConversationId = useReceptionistUiStore((s) => s.activeConversationId);
  const setActiveConversationId = useReceptionistUiStore((s) => s.setActiveConversationId);

  const demo = isDemo();
  const admin = useAuthStore((s) => s.status.admin);
  const authLoaded = useAuthStore((s) => s.statusLoaded);
  const openPairing = useAuthStore((s) => s.openPairing);
  const projectsMap = useOfficeStore((s) => s.projects);
  const settingsLoaded = useSettingsStore((s) => s.settingsLoaded);
  const receptionistEnabled = useSettingsStore((s) => s.settings.receptionist.enabled);
  const allowedProjectDirs = useSettingsStore((s) => s.settings.runner.allowedProjectDirs);

  const conversations = useReceptionistStore((s) => s.conversations);
  const conversationsLoaded = useReceptionistStore((s) => s.conversationsLoaded);
  const messagesByConversation = useReceptionistStore((s) => s.messages);
  const setConversations = useReceptionistStore((s) => s.setConversations);
  const setMessages = useReceptionistStore((s) => s.setMessages);
  const upsertConversation = useReceptionistStore((s) => s.upsertConversation);
  const upsertMessage = useReceptionistStore((s) => s.upsertMessage);
  const removeConversation = useReceptionistStore((s) => s.removeConversation);

  const [runnerStatus, setRunnerStatus] = useState<RunnerStatus | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  /** Which load the Retry button next to `listError` should re-run — the list itself, or the active
   *  conversation's history, whichever most recently failed. */
  const [lastFailedLoad, setLastFailedLoad] = useState<'list' | 'active' | null>(null);
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [sendBusy, setSendBusy] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  /** Below `sm` the list and the thread are two screens (back-button pattern); this is true while the list is the one showing. */
  const [showList, setShowList] = useState(false);

  const projects = useMemo(() => Object.values(projectsMap).filter((p) => !isMultiverseFloor(p.id) && !p.archived), [projectsMap]);
  const list = useMemo(() => (demo ? [DEMO_CONVERSATION] : conversationList(conversations)), [demo, conversations]);
  const active = activeConversationId ? conversations[activeConversationId] : undefined;
  const activeMessages = activeConversationId ? (messagesByConversation[activeConversationId] ?? []) : [];

  const allowed = demo || admin;
  const panelGate = receptionistPanelGate({ settingsLoaded, allowed, receptionistEnabled, authLoaded });

  // Demo mode: seed the canned conversation once and select it; no socket, no server.
  useEffect(() => {
    if (!open || !demo) return;
    setConversations([DEMO_CONVERSATION]);
    setMessages(DEMO_CONVERSATION_ID, DEMO_MESSAGES);
    setActiveConversationId(DEMO_CONVERSATION_ID);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, demo]);

  // Live mode: subscribe to admin-room pushes, load the conversation list and the runner's status
  // while the panel is open. Nothing here runs in demo mode or before an admin session exists.
  const loadList = () => {
    setListError(null);
    receptionistApi
      .list()
      .then(setConversations)
      .catch((err) => {
        setListError(errorMessage(err));
        setLastFailedLoad('list');
      });
  };
  useEffect(() => {
    if (!open || demo || !allowed || !receptionistEnabled) return;
    const unregister = registerReceptionistEvents(getSocket());
    loadList();
    receptionistApi
      .runnerStatus()
      .then(setRunnerStatus)
      .catch(() => setRunnerStatus(null));
    return unregister;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, demo, allowed, receptionistEnabled]);

  // Load one conversation's history when it becomes active (skip the canned demo one — already seeded).
  const loadActive = () => {
    if (!activeConversationId) return;
    setListError(null);
    receptionistApi
      .get(activeConversationId)
      .then(({ conversation, messages }) => {
        upsertConversation(conversation);
        setMessages(activeConversationId, messages);
      })
      .catch((err) => {
        setListError(errorMessage(err));
        setLastFailedLoad('active');
      });
  };
  useEffect(() => {
    if (!open || demo || !allowed || !activeConversationId) return;
    loadActive();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, demo, allowed, activeConversationId]);

  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocus(open, dialogRef, { trap: true, onEscape: closePanel });

  if (!open) return null;

  const createConversation = (scope: ReceptionistScope, projectId?: string) => {
    if (demo) return;
    setCreateBusy(true);
    setCreateError(null);
    receptionistApi
      .create(scope === 'project' ? { scope, projectId } : { scope })
      .then((c) => {
        upsertConversation(c);
        setActiveConversationId(c.id);
      })
      .catch((err) => setCreateError(errorMessage(err)))
      .finally(() => setCreateBusy(false));
  };

  const deleteConversation = (id: string) => {
    if (demo) return;
    if (!window.confirm('Delete this conversation? This cannot be undone.')) return;
    setDeletingId(id);
    receptionistApi
      .delete(id)
      .then(() => {
        removeConversation(id);
        if (activeConversationId === id) setActiveConversationId(null);
      })
      .catch((err) => {
        setListError(errorMessage(err));
        setLastFailedLoad(null); // a delete failure isn't retried by re-running a load
      })
      .finally(() => setDeletingId(null));
  };

  const sendMessage = (text: string) => {
    if (demo || !activeConversationId) return;
    setSendBusy(true);
    setSendError(null);
    receptionistApi
      .send(activeConversationId, text)
      .then((userMessage) => {
        upsertMessage(userMessage);
        // Optimistic: the real `busy: true` push (`receptionist:conversation`) arrives moments later
        // too, but flipping it here immediately disables the composer without waiting for a round trip.
        if (active) upsertConversation({ ...active, busy: true, updatedAt: Date.now() });
      })
      .catch((err) => setSendError(errorMessage(err)))
      .finally(() => setSendBusy(false));
  };

  const stopTurn = () => {
    if (demo || !activeConversationId) return;
    receptionistApi.stop(activeConversationId).catch((err) => setSendError(errorMessage(err)));
  };

  const requestClose = () => closePanel();

  const sendGate = receptionistSendGate({ demo, allowed, receptionistEnabled, runnerStatus });
  const runnerOffline = sendGate === 'runner_offline';
  const capabilityMissing = sendGate === 'capability_missing';
  const sendDisabledReason =
    sendGate === 'not_paired' ? (
      'Pair this browser to send a message.'
    ) : sendGate === 'disabled' ? (
      'The Receptionist is disabled in settings.'
    ) : sendGate === 'runner_offline' ? (
      <>
        The runner is offline — new turns can&apos;t start right now. Run <CopyRunnerCommand /> on the host.{' '}
        <GuideLink href={RUNNER_AND_QUESTS_GUIDE_URL}>Runner &amp; quests guide</GuideLink>
      </>
    ) : sendGate === 'capability_missing' ? (
      <>
        The connected runner is missing a Claude CLI capability every turn needs. Update Claude Code on the host and restart
        the runner. <GuideLink href={RUNNER_AND_QUESTS_GUIDE_URL}>Runner &amp; quests guide</GuideLink>
      </>
    ) : undefined;
  const sendDisabled = sendGate !== 'ready' || !activeConversationId;

  return (
    <div
      ref={dialogRef}
      className="fixed inset-0 z-50 flex flex-col bg-ink-950"
      data-modal="receptionist"
      role="dialog"
      aria-modal="true"
      aria-label="Receptionist"
    >
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-ink-700 bg-ink-900 px-3">
        <span className="font-pixel text-xs font-semibold text-ink-100">Receptionist</span>
        <span
          className="rounded-full bg-emerald-900/40 px-2 py-0.5 text-[10px] font-medium text-emerald-300"
          title="Every Receptionist turn runs Read/Grep/Glob only (plus WebSearch when enabled), in plan mode, sandboxed. It never writes files, runs commands, or proposes to."
        >
          Can read, never change anything
        </span>
        {runnerOffline && <span className="rounded-full bg-amber-900/40 px-2 py-0.5 text-[10px] font-medium text-amber-300">Runner offline</span>}
        {capabilityMissing && <span className="rounded-full bg-red-900/40 px-2 py-0.5 text-[10px] font-medium text-red-300">Capability missing</span>}
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" onClick={requestClose} aria-label="Close">
            ✕
          </Button>
        </div>
      </header>
      {isWindowsRunner(runnerStatus) && (
        <p className="shrink-0 border-b border-ink-700 bg-ink-900 px-3 py-1.5 text-[11px] text-ink-300">
          {WINDOWS_NOTE}{' '}
          <GuideLink href={WINDOWS_LIMITS_URL}>Windows limits</GuideLink>
        </p>
      )}

      {panelGate === 'loading' ? (
        <div className="grid flex-1 place-items-center text-xs text-ink-400">Loading…</div>
      ) : panelGate === 'disabled' ? (
        <div className="grid flex-1 place-items-center p-6 text-center text-xs text-ink-300">The Receptionist is disabled in settings.</div>
      ) : panelGate === 'not_paired' ? (
        <div className="grid flex-1 place-items-center p-6 text-center text-xs text-ink-300">
          <p className="mb-2">Pair this browser to talk to the Receptionist.</p>
          <Button variant="primary" onClick={() => openPairing()}>
            Pair this browser
          </Button>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <ConversationSidebar
            conversations={list}
            activeId={activeConversationId}
            onSelect={(id) => {
              setActiveConversationId(id);
              setShowList(false);
            }}
            hiddenOnMobile={!!activeConversationId && !showList}
            onDelete={deleteConversation}
            deletingId={deletingId}
            projects={projects}
            allowedProjectDirs={allowedProjectDirs}
            onCreate={createConversation}
            createBusy={createBusy}
            createError={createError}
          />
          <div className={cx('min-h-0 flex-1 flex-col', !activeConversationId || showList ? 'hidden sm:flex' : 'flex')}>
            {activeConversationId && (
              <div className="flex shrink-0 items-center border-b border-ink-700 px-2 py-1 sm:hidden">
                <Button variant="ghost" onClick={() => setShowList(true)} aria-label="Back to conversations">
                  ‹ Conversations
                </Button>
                <span className="min-w-0 flex-1 truncate pl-1 text-xs text-ink-300">{active?.title}</span>
              </div>
            )}
            {listError && (
              <p className="flex flex-wrap items-center gap-2 border-b border-ink-700 bg-red-950/40 px-3 py-1.5 text-[11px] text-red-300">
                <span>{listError}</span>
                {lastFailedLoad && (
                  <Button variant="subtle" onClick={lastFailedLoad === 'list' ? loadList : loadActive}>
                    Retry
                  </Button>
                )}
              </p>
            )}
            {!activeConversationId ? (
              <div className="grid flex-1 place-items-center text-xs text-ink-400">
                {conversationsLoaded || demo ? 'Select a conversation, or start a new one.' : 'Loading conversations…'}
              </div>
            ) : (
              <MessageThread
                messages={activeMessages}
                busy={!!active?.busy}
                disabled={sendDisabled}
                disabledReason={sendDisabledReason}
                onSend={sendMessage}
                onStop={stopTurn}
                sendBusy={sendBusy}
                sendError={sendError}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
