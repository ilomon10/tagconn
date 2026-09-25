import { randomUUID } from 'node:crypto';
import {
  isTerminalRunStatus,
  type ConversationCreate,
  type ReceptionistConversation,
  type ReceptionistMessage,
  type ReceptionistSend,
  type Run,
  type RunEventEnvelope,
} from '@tagconn/shared';
import type { Deps } from '../../core/di/index.js';
import { HttpError, notFound } from '../../core/http/index.js';
import { redactValue } from '../../core/redact/index.js';
import { applyRunEvent, assertProjectDirAllowed, emptyAccumulator, type AssistantTurnAccumulator } from './receptionist.validate.js';

const DEFAULT_TITLE = 'New conversation';

type ReceptionistDeps = Deps<'receptionistRepository' | 'projectsRepository' | 'settings' | 'bus' | 'logger' | 'runDispatcher'>;

/**
 * Conversations and turns for the Receptionist help desk (M8 8l, S3). See
 * docs/design/runner-and-helpdesk.md §4 and §9 (row S3). Every turn goes through the `RunDispatcher`
 * port (`modules/runs`, S2); this service never talks to the runner directly and never builds argv —
 * that is entirely `RunsService.startReceptionistTurn`'s job (it reads `settings.receptionist.*`
 * itself). This service is responsible for what the design assigns to S3 specifically:
 *  - conversation/message storage, bounded by `receptionist.maxConversations`/`maxMessagesPerConversation`
 *  - one turn in flight per conversation
 *  - "project scope ONLY for registered projects whose cwd is inside settings.runner.allowedProjectDirs"
 *    (a check `RunsService.startReceptionistTurn` does NOT make: it only resolves `projectId` -> `cwd`)
 *  - projecting the run's event stream onto `ReceptionistMessage`s, and storing the runner session id
 *    for `--resume`
 */
export class ReceptionistService {
  /** Per-run, in-memory text/tool accumulation while a turn streams (§2.5). Ephemeral by design: it only
   * matters while the run is active, and is rebuilt implicitly (fine, best-effort) if the process restarts
   * mid-turn, since the message already holds whatever was persisted up to that point. */
  private readonly turnAccumulators = new Map<string, AssistantTurnAccumulator>();

  constructor(private readonly deps: ReceptionistDeps) {}

  private assertEnabled(): void {
    if (!this.deps.settings.get().receptionist.enabled) throw notFound('Receptionist');
  }

  private requireConversation(id: string): ReceptionistConversation {
    const conversation = this.deps.receptionistRepository.getConversation(id);
    if (!conversation) throw notFound(`Conversation ${id}`);
    return conversation;
  }

  /** §9 S3: registered project, inside `settings.runner.allowedProjectDirs`. Re-run at both create and
   * send time: settings or the project's registration can change between the two. */
  private assertProjectScopeAllowed(projectId: string, allowedProjectDirs: readonly string[]): void {
    const project = this.deps.projectsRepository.get(projectId);
    if (!project) throw new HttpError(400, `Unknown projectId "${projectId}"`);
    assertProjectDirAllowed(project.cwd, allowedProjectDirs);
  }

  private enforceConversationBound(max: number): void {
    const all = this.deps.receptionistRepository.listConversations();
    if (all.length < max) return;
    const evictable = [...all].filter((c) => !c.busy).sort((a, b) => a.updatedAt - b.updatedAt)[0];
    if (!evictable) throw new HttpError(400, `receptionist.maxConversations (${max}) reached and every conversation is busy`);
    this.deps.receptionistRepository.deleteConversation(evictable.id);
    this.deps.bus.emit('receptionist.conversationRemoved', evictable.id);
  }

  private enforceMessageBound(conversationId: string): void {
    const { maxMessagesPerConversation } = this.deps.settings.get().receptionist;
    this.deps.receptionistRepository.pruneOldestMessages(conversationId, maxMessagesPerConversation);
  }

  // -------------------------------------------------------------- REST + socket surface

  list(): ReceptionistConversation[] {
    this.assertEnabled();
    return this.deps.receptionistRepository.listConversations();
  }

  get(id: string): { conversation: ReceptionistConversation; messages: ReceptionistMessage[] } {
    this.assertEnabled();
    const conversation = this.requireConversation(id);
    return { conversation, messages: this.deps.receptionistRepository.listMessages(id) };
  }

  create(input: ConversationCreate, createdBy: string): ReceptionistConversation {
    this.assertEnabled();
    const { receptionist, runner } = this.deps.settings.get();

    if (input.scope === 'general') {
      if (input.projectId) throw new HttpError(400, 'projectId is only valid for scope "project"');
    } else if (!input.projectId) {
      throw new HttpError(400, 'scope "project" requires projectId');
    } else {
      this.assertProjectScopeAllowed(input.projectId, runner.allowedProjectDirs);
    }

    this.enforceConversationBound(receptionist.maxConversations);

    const now = Date.now();
    const conversation: ReceptionistConversation = {
      id: randomUUID(),
      title: input.title?.trim() || DEFAULT_TITLE,
      scope: input.scope,
      projectId: input.scope === 'project' ? input.projectId : undefined,
      messageCount: 0,
      busy: false,
      createdAt: now,
      updatedAt: now,
    };
    this.deps.receptionistRepository.insertConversation(conversation);
    this.deps.bus.emit('receptionist.conversationUpserted', conversation);
    this.deps.logger.info({ conversationId: conversation.id, scope: conversation.scope, createdBy }, 'receptionist conversation created');
    return conversation;
  }

  /** Starts a turn via `RunDispatcher.startReceptionistTurn` (kind 'receptionist'); replies with the
   * stored user message (§4.1, contract `receptionist:send`). Throws 409 if the conversation is busy. */
  send(req: ReceptionistSend, createdBy: string): ReceptionistMessage {
    this.assertEnabled();
    const conversation = this.requireConversation(req.conversationId);
    if (conversation.busy) throw new HttpError(409, 'This conversation already has a turn in flight');

    const { runner } = this.deps.settings.get();
    let projectId: string | null = null;
    if (conversation.scope === 'project') {
      if (!conversation.projectId) throw new HttpError(409, 'Conversation has no project'); // defensive; create() guarantees this
      this.assertProjectScopeAllowed(conversation.projectId, runner.allowedProjectDirs); // re-checked: may have changed since create()
      projectId = conversation.projectId;
    }

    const run = this.deps.runDispatcher.startReceptionistTurn({
      conversationId: conversation.id,
      projectId,
      prompt: req.text,
      resumeSessionId: conversation.sessionId,
      createdBy,
    });
    this.turnAccumulators.set(run.id, emptyAccumulator());

    const now = Date.now();
    const userMessage: ReceptionistMessage = {
      id: randomUUID(),
      conversationId: conversation.id,
      role: 'user',
      text: redactValue(req.text, this.deps.settings.get().ingest.redactPatterns),
      runId: run.id,
      createdAt: now,
    };
    this.deps.receptionistRepository.insertMessage(userMessage);
    this.enforceMessageBound(conversation.id);

    // One assistant message per turn, created empty and upserted as `run:event`s stream in (§4.1).
    const assistantMessage: ReceptionistMessage = {
      id: randomUUID(),
      conversationId: conversation.id,
      role: 'assistant',
      text: '',
      runId: run.id,
      status: run.status,
      createdAt: now + 1, // after the user message it replies to, even within the same millisecond
    };
    this.deps.receptionistRepository.insertMessage(assistantMessage);
    this.enforceMessageBound(conversation.id);

    const updated: ReceptionistConversation = {
      ...conversation,
      busy: true,
      messageCount: this.deps.receptionistRepository.countMessages(conversation.id),
      updatedAt: now,
    };
    this.deps.receptionistRepository.updateConversation(updated, run.id);
    this.deps.bus.emit('receptionist.conversationUpserted', updated);
    this.deps.bus.emit('receptionist.messageUpserted', userMessage);
    this.deps.bus.emit('receptionist.messageUpserted', assistantMessage);
    return userMessage;
  }

  /** Stops the conversation's in-flight turn, if any (idempotent: a no-op when not busy). */
  stop(conversationId: string): void {
    this.assertEnabled();
    const conversation = this.requireConversation(conversationId);
    if (!conversation.busy) return;
    const runId = this.deps.receptionistRepository.getActiveRunId(conversationId);
    if (runId) this.deps.runDispatcher.stop(runId, 'stopped_by_user');
  }

  delete(conversationId: string): void {
    this.assertEnabled();
    const conversation = this.requireConversation(conversationId);
    if (conversation.busy) {
      const runId = this.deps.receptionistRepository.getActiveRunId(conversationId);
      if (runId) this.deps.runDispatcher.stop(runId, 'stopped_by_user');
    }
    this.deps.receptionistRepository.deleteConversation(conversationId);
    this.deps.bus.emit('receptionist.conversationRemoved', conversationId);
  }

  // -------------------------------------------------------------- run event/status -> message projection

  /** `bus.on('run.event', ...)`: only receptionist runs started by this service are ever handled here
   * (identified via `RunDispatcher.get`, which carries `conversationId`). */
  onRunEvent(env: RunEventEnvelope): void {
    const run = this.deps.runDispatcher.get(env.runId);
    if (!run || run.kind !== 'receptionist' || !run.conversationId) return;
    const message = this.deps.receptionistRepository.getMessageByRunId(run.id, 'assistant');
    if (!message) return;

    const acc = applyRunEvent(this.turnAccumulators.get(run.id) ?? emptyAccumulator(), env.event);
    this.turnAccumulators.set(run.id, acc);

    const updated: ReceptionistMessage = { ...message, text: acc.text, tools: acc.tools.length > 0 ? acc.tools : undefined };
    this.deps.receptionistRepository.updateMessage(updated);
    this.deps.bus.emit('receptionist.messageUpserted', updated);
  }

  /** `bus.on('run.upserted', ...)`: tracks the assistant message's status, stores the runner session id
   * for `--resume` as soon as it is known (from `init`), and clears `busy`/`activeRunId` at the end of
   * the turn (§4.1 "one turn at a time", §2.6 correlation). */
  onRunUpserted(run: Run): void {
    if (run.kind !== 'receptionist' || !run.conversationId) return;
    const conversation = this.deps.receptionistRepository.getConversation(run.conversationId);
    if (!conversation) {
      this.turnAccumulators.delete(run.id);
      return;
    }

    let message = this.deps.receptionistRepository.getMessageByRunId(run.id, 'assistant');
    let messageChanged = false;
    if (message && message.status !== run.status) {
      message = { ...message, status: run.status };
      messageChanged = true;
    }

    const terminal = isTerminalRunStatus(run.status);
    let updatedConversation = conversation;
    let conversationChanged = false;

    if (run.sessionId && conversation.sessionId !== run.sessionId) {
      updatedConversation = { ...updatedConversation, sessionId: run.sessionId };
      conversationChanged = true;
    }

    if (terminal) {
      if (message && !message.text && run.status !== 'succeeded') {
        message = { ...message, text: run.error ?? `Turn ended: ${run.status}${run.endReason ? ` (${run.endReason})` : ''}` };
        messageChanged = true;
      }
      updatedConversation = { ...updatedConversation, busy: false, updatedAt: Date.now() };
      conversationChanged = true;
      this.turnAccumulators.delete(run.id);
    }

    if (message && messageChanged) {
      this.deps.receptionistRepository.updateMessage(message);
      this.deps.bus.emit('receptionist.messageUpserted', message);
    }
    if (conversationChanged) {
      this.deps.receptionistRepository.updateConversation(updatedConversation, terminal ? null : undefined);
      this.deps.bus.emit('receptionist.conversationUpserted', updatedConversation);
    }
  }
}
