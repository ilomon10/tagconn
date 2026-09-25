import { aliasTo, asClass } from 'awilix';
import fp from 'fastify-plugin';
import { authRoutes } from './auth.routes.js';
import { AuthRepository } from './auth.repository.js';
import { AuthService } from './auth.service.js';
import { registerAuthSocket } from './auth.socket.js';

declare module '@fastify/awilix' {
  interface Cradle {
    authRepository: AuthRepository;
    authService: AuthService;
  }
}

/**
 * Admin auth (M8 8m): admin sessions, pairing challenges/codes, `/api/auth/*`, `auth:*`. Registers
 * `authService` (implements `AdminVerifier`) under the core `adminVerifier` DI key, which
 * `core/http/admin.ts` and `core/realtime/admin-guard.ts` both read lazily — this is the only module
 * that constructs an AuthService, but neither core file imports it directly.
 * See docs/design/runner-and-helpdesk.md §5.
 */
export const authModule = fp(
  async (app) => {
    app.diContainer.register({
      authRepository: asClass(AuthRepository).singleton(),
      authService: asClass(AuthService).singleton(),
      adminVerifier: aliasTo('authService'),
    });
    const { cradle } = app.diContainer;
    cradle.authService.logBootPairingCodeIfNeeded();
    registerAuthSocket(cradle);
    await app.register(authRoutes);
  },
  { name: 'auth', dependencies: ['core-di', 'core-http', 'core-realtime'] },
);
