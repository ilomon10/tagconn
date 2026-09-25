import fp from 'fastify-plugin';

/** M8 placeholder, filled in by its task (see docs/design/runner-and-helpdesk.md §9). */
export const runsModule = fp(async () => {}, { name: 'runs', dependencies: ['core-http'] });
