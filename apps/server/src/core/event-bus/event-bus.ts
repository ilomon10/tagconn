import type {
  Activity,
  Agent,
  Hero,
  HookPayload,
  OfficeEvent,
  OfficeLayout,
  PendingProfileImport,
  Project,
  ReceptionistConversation,
  ReceptionistMessage,
  Role,
  Run,
  RunEventEnvelope,
  RunnerStatus,
  Session,
  Settings,
  Task,
} from '@tagconn/shared';

/**
 * One hook as it flows through the modules. Listeners on 'hook.received' run in module registration
 * order (projects → sessions → agents → transcripts → tasks → events) and enrich this object for
 * later listeners.
 */
export interface HookContext {
  payload: HookPayload;
  ts: number;
  /** Set by projects. */
  projectId: string;
  sessionId: string;
  /** Set by agents: the agent the event is attributed to. */
  agentId: string;
  /** Set by agents. */
  role?: string;
  activity?: Activity;
  bubble?: string;
  /** Set by agents on SubagentStart when a pending Agent tool call was matched. */
  linkedToolUseId?: string;
  /** Set by ingest when settings.ingest.storeToolPayloads is on. */
  storePayload?: boolean;
  /**
   * Set by ingest from the `x-tagconn-run-id` header (M8 8k, S5), already validated as UUID-shaped.
   * Sessions uses it to set `Session.runId`/`origin` via `runLinker`/`runDispatcher`; see
   * docs/design/runner-and-helpdesk.md §2.6 "Hint". Never authoritative on its own (`init` wins).
   */
  runIdHint?: string;
}

export interface BusEvents {
  'hook.received': HookContext;
  'project.upserted': Project;
  'session.upserted': Session;
  'agent.upserted': Agent;
  'agent.removed': { id: string; projectId: string };
  'task.upserted': Task;
  'event.created': OfficeEvent;
  'settings.changed': { settings: Settings; changed: string[] };
  'roles.changed': Role[];
  /** A layout was created or replaced (M7). Layouts are global: broadcast to every client. */
  'layout.upserted': OfficeLayout;
  /** A layout was deleted; `layout.removed` id is a `LAYOUT_ID_RE` string. */
  'layout.removed': string;
  /** A hero was created, bound, released, edited or reset (M8 8i). */
  'hero.upserted': Hero;
  /** A hero was deleted. */
  'hero.removed': { id: string; projectId: string };
  /** A run (quest or receptionist turn) was created or changed status (M8 8k, S2). */
  'run.upserted': Run;
  /** One redacted, capped `RunEvent` accepted from the verified runner it was dispatched to. */
  'run.event': RunEventEnvelope;
  /** A run's Claude `sessionId` became known (from `init`, or the `x-tagconn-run-id` hint). */
  'run.linked': { runId: string; sessionId: string; projectId?: string };
  /** A quest was assigned to a hero at start time (8i); the prompt was prefixed accordingly. */
  'run.heroRequested': { runId: string; projectId: string; heroId: string; role: string };
  /** The single connected runner's connection/capabilities/queue state changed. */
  'runner.status': RunnerStatus;
  /** A Receptionist conversation was created, or its scope/session/busy/title state changed (M8 8l, S3). */
  'receptionist.conversationUpserted': ReceptionistConversation;
  /** A Receptionist conversation was deleted. */
  'receptionist.conversationRemoved': string;
  /** A Receptionist message was created or updated (the assistant message upserts as its turn streams). */
  'receptionist.messageUpserted': ReceptionistMessage;
  /** A `.tagconn/office.json` import became pending admin review, or an existing one was refreshed (M8 8j, S4). */
  'attribution.pending': PendingProfileImport;
  /** A pending import was resolved (imported or dismissed); the admin toast for it should be cleared. */
  'attribution.pendingCleared': string;
}

type Listener<T> = (payload: T) => void;

/**
 * Typed synchronous in-process bus. Unlike a bare EventEmitter, a throwing listener is logged and
 * does not prevent later listeners (or the emitter, e.g. the hook endpoint) from running.
 */
export class EventBus {
  private readonly listeners = new Map<keyof BusEvents, Listener<never>[]>();

  constructor(private readonly onError: (err: unknown, event: keyof BusEvents) => void = () => {}) {}

  on<K extends keyof BusEvents>(event: K, listener: Listener<BusEvents[K]>): () => void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener as Listener<never>);
    this.listeners.set(event, list);
    return () => this.off(event, listener);
  }

  off<K extends keyof BusEvents>(event: K, listener: Listener<BusEvents[K]>): void {
    const list = this.listeners.get(event);
    if (!list) return;
    const i = list.indexOf(listener as Listener<never>);
    if (i >= 0) list.splice(i, 1);
  }

  emit<K extends keyof BusEvents>(event: K, payload: BusEvents[K]): void {
    const list = this.listeners.get(event);
    if (!list) return;
    for (const listener of [...list]) {
      try {
        (listener as Listener<BusEvents[K]>)(payload);
      } catch (err) {
        this.onError(err, event);
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
