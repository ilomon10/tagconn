import { rooms } from '@tagconn/shared';
import type { Deps } from '../../core/di/index.js';
import { ackify } from '../../core/realtime/index.js';

/** 'office:subscribe'(projectId | '*'): switch the socket's floor room and ack a snapshot. */
export function registerSnapshotSocket({ office, snapshotService }: Deps<'office' | 'snapshotService'>): void {
  office.on('connection', (socket) => {
    socket.on(
      'office:subscribe',
      ackify((projectId: string) => {
        if (typeof projectId !== 'string' || !projectId) throw new Error('projectId required');
        for (const room of socket.rooms) if (room.startsWith('project:')) void socket.leave(room);
        void socket.join(projectId === '*' ? rooms.all : rooms.project(projectId));
        return snapshotService.build(projectId);
      }),
    );
  });
}
