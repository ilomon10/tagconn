import { ConversationCreateSchema } from '@tagconn/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { bearerToken } from '../../core/http/index.js';
import { createdByFrom } from './receptionist.caller.js';
import { ConversationIdParamsSchema, ReceptionistSendBodySchema } from './receptionist.schema.js';

/**
 * Receptionist REST (docs/design/runner-and-helpdesk.md §5.3: "/api/receptionist*" is always `admin`).
 * The socket equivalents (`receptionist:*`) are in `receptionist.socket.ts`. `receptionist.enabled ===
 * false` makes every handler below throw a 404 (via `ReceptionistService`'s `assertEnabled`).
 */
export const receptionistRoutes: FastifyPluginAsyncZod = async (app) => {
  const { receptionistService, adminVerifier } = app.diContainer.cradle;
  const who = (req: Parameters<typeof bearerToken>[0]) => createdByFrom(adminVerifier, bearerToken(req));

  app.get('/api/receptionist/conversations', { config: { access: 'admin' } }, async () => receptionistService.list());

  app.get(
    '/api/receptionist/conversations/:id',
    { config: { access: 'admin' }, schema: { params: ConversationIdParamsSchema } },
    async (req) => receptionistService.get(req.params.id),
  );

  app.post(
    '/api/receptionist/conversations',
    { config: { access: 'admin' }, schema: { body: ConversationCreateSchema } },
    async (req, reply) => {
      const conversation = receptionistService.create(req.body, who(req));
      reply.code(201);
      return conversation;
    },
  );

  app.post(
    '/api/receptionist/conversations/:id/messages',
    { config: { access: 'admin' }, schema: { params: ConversationIdParamsSchema, body: ReceptionistSendBodySchema } },
    async (req, reply) => {
      const message = receptionistService.send({ conversationId: req.params.id, text: req.body.text }, who(req));
      reply.code(201);
      return message;
    },
  );

  app.post(
    '/api/receptionist/conversations/:id/stop',
    { config: { access: 'admin' }, schema: { params: ConversationIdParamsSchema } },
    async (req, reply) => {
      receptionistService.stop(req.params.id);
      return reply.code(204).send();
    },
  );

  app.delete(
    '/api/receptionist/conversations/:id',
    { config: { access: 'admin' }, schema: { params: ConversationIdParamsSchema } },
    async (req, reply) => {
      receptionistService.delete(req.params.id);
      return reply.code(204).send();
    },
  );
};
