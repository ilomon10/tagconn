import type { OfficeHandshakeAuth } from '@tagconn/shared';
import type { Deps } from '../../core/di/index.js';
import { ackify } from '../../core/realtime/index.js';

export function registerAuthSocket({ office, authService }: Deps<'office' | 'authService'>): void {
  office.on('connection', (socket) => {
    const token = () => (socket.handshake.auth as OfficeHandshakeAuth | undefined)?.adminToken;

    socket.on('auth:status', ackify(() => authService.status(token())));

    socket.on(
      'auth:sessions',
      ackify(() => {
        const check = authService.verify(token());
        return authService.listSessions(check.ok ? check.sessionId : undefined);
      }),
    );

    socket.on(
      'auth:revoke',
      ackify((sessionId: string): true => {
        authService.revoke(sessionId);
        return true;
      }),
    );
  });
}
