import type { Deps } from '../../core/di/index.js';
import { HttpError } from '../../core/http/index.js';
import { ackify } from '../../core/realtime/index.js';
import { RoleBodySchema } from './roles.schema.js';

export function registerRolesSocket({ office, rolesService }: Deps<'office' | 'rolesService'>): void {
  office.on('connection', (socket) => {
    socket.on('roles:list', ackify(() => rolesService.list()));
    socket.on(
      'roles:save',
      ackify((input: unknown) => {
        // Same boundary schema as the REST body (`PUT /api/roles/:name`); name comes from the payload
        // here instead of a URL param.
        const role = RoleBodySchema.parse(input);
        if (!role.name) throw new HttpError(400, 'Role name is required');
        return rolesService.save(role.name, role);
      }),
    );
    socket.on(
      'roles:delete',
      ackify((name: string) => {
        rolesService.delete(name);
        return true as const;
      }),
    );
    socket.on('roles:sync', ackify(() => rolesService.sync()));
  });
}
