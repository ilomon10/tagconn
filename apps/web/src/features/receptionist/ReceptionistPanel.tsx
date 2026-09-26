import { useEffect, useMemo, useState } from 'react';
import type { ReceptionistScope, RunnerStatus } from '@tagconn/shared';
import { useOfficeStore } from '../../stores/officeStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useAuthStore } from '../../stores/authStore';
import { conversationList, registerReceptionistEvents, useReceptionistStore } from '../../stores/receptionistStore';
import { getSocket } from '../../lib/socket';
import { isDemo } from '../../lib/connection';
import { isMultiverseFloor, isTypingTarget } from '../../lib/floors';
import { Button } from '../../components/ui';
import { useReceptionistUiStore } from './uiStore';
import { AckError, AckTimeoutError, receptionistApi } from './receptionistApi';
import { DEMO_CONVERSATION, DEMO_CONVERSATION_ID, DEMO_MESSAGES } from './demoData';
import { ConversationSidebar } from './ConversationSidebar';
import { MessageThread } from './MessageThread';

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
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [sendBusy, setSendBusy] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const projects = useMemo(() => Object.values(projectsMap).filter((p) => !isMultiverseFloor(p.id) && !p.archived), [projectsMap]);
  const list = useMemo(() => (demo ? [DEMO_CONVERSATION] : conversationList(conversations)), [demo, conversations]);
  const active = activeConversationId ? conversations[activeConversationId] : undefined;
  const activeMessages = activeConversationId ? (messagesByConversation[activeConversationId] ?? []) : [];

  const allowed = demo || admin;
  const gateReason = !receptionistEnabled ? 'The Receptionist is disabled in settings.' : !allowed ? 'Pair this browser to talk to the Receptionist.' : null;

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
  useEffect(() => {
    if (!open || demo || !allowed || !receptionistEnabled) return;
    const unregister = registerReceptionistEvents(getSocket());
    setListError(null);
    receptionistApi
      .list()
      .then(setConversations)
      .catch((err) => setListError(errorMessage(err)));
    receptionistApi
      .runnerStatus()
      .then(setRunnerStatus)
      .catch(() => setRunnerStatus(null));
    return unregister;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, demo, allowed, receptionistEnabled]);

  // Load one conversation's history when it becomes active (skip the canned demo one — already seeded).
  useEffect(() => {
    if (!open || demo || !allowed || !activeConversationId) return;
    receptionistApi
      .get(activeConversationId)
      .then(({ conversation, messages }) => {
        upsertConversation(conversation);
        setMessages(activeConversationId, messages);
      })
      .catch((err) => setListError(errorMessage(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, demo, allowed, activeConversationId]);

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
      .catch((err) => setListError(errorMessage(err)))
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

  const onKeyDownCapture = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && !isTypingTarget(e.target as EventTarget)) {
      e.stopPropagation();
      requestClose();
    }
  };

  const runnerOffline = !demo && allowed && runnerStatus !== null && !runnerStatus.connected;
  const sendDisabledReason = !allowed
    ? 'Pair this browser to send a message.'
    : !receptionistEnabled
      ? 'The Receptionist is disabled in settings.'
      : runnerOffline
        ? 'The runner is offline — new turns cannot start right now.'
        : undefined;
  const sendDisabled = !allowed || !receptionistEnabled || runnerOffline || !activeConversationId;

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-ink-950"
      data-modal="receptionist"
      role="dialog"
      aria-modal="true"
      aria-label="Receptionist"
      onKeyDownCapture={onKeyDownCapture}
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
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" onClick={requestClose} aria-label="Close">
            ✕
          </Button>
        </div>
      </header>

      {!settingsLoaded ? (
        <div className="grid flex-1 place-items-center text-xs text-ink-400">Loading…</div>
      ) : gateReason ? (
        <div className="grid flex-1 place-items-center p-6 text-center text-xs text-ink-400">{gateReason}</div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <ConversationSidebar
            conversations={list}
            activeId={activeConversationId}
            onSelect={setActiveConversationId}
            onDelete={deleteConversation}
            deletingId={deletingId}
            projects={projects}
            allowedProjectDirs={allowedProjectDirs}
            onCreate={createConversation}
            createBusy={createBusy}
            createError={createError}
          />
          <div className="flex min-h-0 flex-1 flex-col">
            {listError && <p className="border-b border-ink-700 bg-red-950/40 px-3 py-1.5 text-[11px] text-red-300">{listError}</p>}
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
