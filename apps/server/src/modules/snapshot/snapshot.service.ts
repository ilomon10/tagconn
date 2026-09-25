import type { OfficeSnapshot, Session } from '@tagconn/shared';
import type { Deps } from '../../core/di/index.js';
import { publicAgent } from '../agents/index.js';

/** Ended sessions and finished tasks stay in the snapshot this long. */
const RECENT_MS = 24 * 60 * 60 * 1000;

type SnapshotDeps = Deps<
  'projectsRepository' | 'sessionsRepository' | 'agentsRepository' | 'tasksRepository' | 'eventsRepository' | 'layoutsRepository' | 'settings'
>;

/** Read model for a (re)connecting client: live floor + recent context. */
export class SnapshotService {
  constructor(private readonly deps: SnapshotDeps) {}

  build(projectId?: string, now = Date.now()): OfficeSnapshot {
    const d = this.deps;
    const pid = projectId && projectId !== '*' ? projectId : undefined;
    const since = now - RECENT_MS;
    const agents = d.agentsRepository.listLive(pid).map(publicAgent);

    const sessions = new Map<string, Session>(d.sessionsRepository.listRecent(since, pid).map((s) => [s.id, s]));
    const missing = [...new Set(agents.map((a) => a.sessionId))].filter((id) => !sessions.has(id));
    for (const s of d.sessionsRepository.byIds(missing)) sessions.set(s.id, s);

    const project = pid ? d.projectsRepository.get(pid) : undefined;
    const limit = d.settings.get().storage.snapshotEventLimit;
    return {
      projects: pid ? (project ? [project] : []) : d.projectsRepository.list(),
      sessions: [...sessions.values()],
      agents,
      tasks: d.tasksRepository.listRecent(since, pid),
      events: limit > 0 ? d.eventsRepository.list({ projectId: pid, limit }) : [],
      // Layouts are global (M7), not per floor, so every snapshot carries the full list.
      layouts: d.layoutsRepository.list(),
    };
  }
}
