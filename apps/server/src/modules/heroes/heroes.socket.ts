import { HeroCreateSchema, HeroListRequestSchema, HeroUpdateRequestSchema, type Hero } from '@tagconn/shared';
import { z } from 'zod';
import type { Deps } from '../../core/di/index.js';
import { ackify } from '../../core/realtime/index.js';

/** Loose on purpose for `heroes:reset`/`heroes:delete` (mirrors `LayoutIdSchema`): the service itself
 * checks `HERO_ID_RE` before any DB access, so a malformed id still reports a client-safe error. */
const HeroIdSchema = z.string().min(1).max(64);

export function registerHeroesSocket({ office, heroesService }: Deps<'office' | 'heroesService'>): void {
  office.on('connection', (socket) => {
    socket.on('heroes:list', ackify((req: unknown): Hero[] => heroesService.list(HeroListRequestSchema.parse(req).projectId)));
    socket.on('heroes:create', ackify((req: unknown): Hero => heroesService.create(HeroCreateSchema.parse(req))));
    socket.on(
      'heroes:update',
      ackify((req: unknown): Hero => {
        const { id, patch } = HeroUpdateRequestSchema.parse(req);
        return heroesService.patch(id, patch);
      }),
    );
    socket.on('heroes:reset', ackify((id: unknown): Hero => heroesService.reset(HeroIdSchema.parse(id))));
    socket.on(
      'heroes:delete',
      ackify((id: unknown): true => {
        heroesService.delete(HeroIdSchema.parse(id));
        return true;
      }),
    );
  });
}
