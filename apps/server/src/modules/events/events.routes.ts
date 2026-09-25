import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { EventsQuerySchema } from './events.schema.js';

export const eventsRoutes: FastifyPluginAsyncZod = async (app) => {
  const { eventsService } = app.diContainer.cradle;
  app.get('/api/events', { schema: { querystring: EventsQuerySchema } }, async (req) => eventsService.list(req.query));
};
