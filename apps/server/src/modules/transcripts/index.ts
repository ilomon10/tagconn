import { asClass } from 'awilix';
import fp from 'fastify-plugin';
import { TranscriptsService } from './transcripts.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    transcriptsService: TranscriptsService;
  }
}

/**
 * Reads token usage from Claude Code transcripts and mirrors it onto agents.usage / sessions.usage.
 * Runs after agents (the agent row must already exist) and sessions (the session row must already
 * exist for the recompute step). No socket/routes of its own: it re-emits the existing agent/session
 * upsert bus events, which core/realtime already broadcasts.
 */
export const transcriptsModule = fp(
  async (app) => {
    app.diContainer.register({ transcriptsService: asClass(TranscriptsService).singleton() });
    const { bus, settings, transcriptsService } = app.diContainer.cradle;
    bus.on('hook.received', (ctx) => transcriptsService.onHook(ctx));
    bus.on('settings.changed', ({ changed }) => {
      if (changed.includes('transcripts.enabled') && !settings.get().transcripts.enabled) transcriptsService.disable();
    });
    // Backstop for sessions/agents that never got an explicit SessionEnd/SubagentStop (e.g. a
    // crashed/killed CLI): the sessions/agents sweepers eventually mark them ended/removed from a
    // timer, not a hook, so this is the only place that stops tracking their files.
    bus.on('agent.removed', ({ id }) => transcriptsService.untrackAgent(id));
    bus.on('session.upserted', (s) => {
      if (s.status === 'ended') setImmediate(() => transcriptsService.finalizeSession(s.id));
    });
    app.addHook('onClose', async () => transcriptsService.stop());
  },
  { name: 'transcripts', dependencies: ['core-di', 'agents', 'sessions'] },
);
