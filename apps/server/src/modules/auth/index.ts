import fp from 'fastify-plugin';

/** M8 placeholder, filled in by its task (see docs/design/runner-and-helpdesk.md §9). */
export const authModule = fp(async () => {}, { name: 'auth', dependencies: ['core-http'] });
