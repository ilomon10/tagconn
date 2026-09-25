import type {
  AdminSessionInfo,
  AuthStatus,
  AuthTokenResponse,
  BootstrapRequest,
  Hero,
  HeroCreate,
  HeroPatch,
  OfficeEvent,
  OfficeLayout,
  OfficeLayoutInput,
  OfficeSnapshot,
  PairRequest,
  Project,
  Role,
  Settings,
  SettingsPatch,
} from '@tagconn/shared';
import { clearStoredToken, emitAuthEvent, PAIR_TO_CHANGE_MESSAGE, readStoredToken } from './auth';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init?.timeoutMs ?? 8000);
  try {
    const method = (init?.method ?? 'GET').toUpperCase();
    const write = method !== 'GET' && method !== 'HEAD';
    const token = readStoredToken();
    // The server only accepts JSON bodies on writes (415 otherwise), even for body-less actions.
    const res = await fetch(path, {
      ...init,
      body: write ? (init?.body ?? '{}') : undefined,
      signal: ctrl.signal,
      headers: {
        ...(write ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...init?.headers,
      },
    });
    const text = await res.text();
    const body: unknown = text ? JSON.parse(text) : undefined;
    if (!res.ok) {
      // A 401 means the presented token (if any) is no longer good — drop it and let the UI fall back
      // to the read-only view instead of retrying with a dead token (docs/design/runner-and-helpdesk.md
      // section 5.3, "Web" bullet). `stores/authStore.ts` turns this into `status.admin = false` + toast.
      if (res.status === 401) {
        clearStoredToken();
        emitAuthEvent({ reason: 'unauthenticated', message: PAIR_TO_CHANGE_MESSAGE });
      }
      const msg = body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : res.statusText;
      throw new ApiError(msg, res.status);
    }
    return body as T;
  } finally {
    clearTimeout(timer);
  }
}

const qs = (params: Record<string, string | number | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

const json = (body: unknown) => JSON.stringify(body);

export const api = {
  health: () => request<{ ok: boolean; version?: string } & Record<string, unknown>>('/api/health', { timeoutMs: 3000 }),
  snapshot: (projectId?: string) => request<OfficeSnapshot>(`/api/snapshot${qs({ projectId })}`),
  events: (q: { projectId?: string; limit?: number; before?: number }) => request<OfficeEvent[]>(`/api/events${qs(q)}`),
  getSettings: () => request<Settings>('/api/settings'),
  patchSettings: (patch: SettingsPatch) => request<{ settings: Settings; restartRequired: string[] }>('/api/settings', { method: 'PATCH', body: json(patch) }),
  resetSettings: () => request<Settings>('/api/settings/reset', { method: 'POST' }),
  roles: () => request<Role[]>('/api/roles'),
  saveRole: (role: Role) => request<Role>(`/api/roles/${encodeURIComponent(role.name)}`, { method: 'PUT', body: json(role) }),
  deleteRole: (name: string) => request<unknown>(`/api/roles/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  syncRoles: () => request<{ written: string[]; removed: string[] }>('/api/roles/sync', { method: 'POST' }),
  projects: () => request<Project[]>('/api/projects'),
  patchProject: (id: string, patch: { name?: string; archived?: boolean }) =>
    request<Project>(`/api/projects/${encodeURIComponent(id)}`, { method: 'PATCH', body: json(patch) }),
  // M7 office editor (guild-hall.md section 2). Layouts are global (not per project).
  layouts: () => request<OfficeLayout[]>('/api/layouts'),
  layout: (id: string) => request<OfficeLayout>(`/api/layouts/${encodeURIComponent(id)}`),
  createLayout: (input: OfficeLayoutInput) => request<OfficeLayout>('/api/layouts', { method: 'POST', body: json(input) }),
  saveLayout: (id: string, input: OfficeLayoutInput) => request<OfficeLayout>(`/api/layouts/${encodeURIComponent(id)}`, { method: 'PUT', body: json(input) }),
  deleteLayout: (id: string) => request<unknown>(`/api/layouts/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /** `PATCH /api/projects/:id { layoutId }`: assign (or clear, with null) a floor's layout. */
  assignLayout: (projectId: string, layoutId: string | null) =>
    request<Project>(`/api/projects/${encodeURIComponent(projectId)}`, { method: 'PATCH', body: json({ layoutId }) }),
  // M8 8i heroes (docs/design/living-office.md section 3.3). Omitted projectId = every hero.
  heroes: (projectId?: string) => request<Hero[]>(`/api/heroes${qs({ projectId })}`),
  createHero: (input: HeroCreate) => request<Hero>('/api/heroes', { method: 'POST', body: json(input) }),
  patchHero: (id: string, patch: HeroPatch) => request<Hero>(`/api/heroes/${encodeURIComponent(id)}`, { method: 'PATCH', body: json(patch) }),
  resetHero: (id: string) => request<Hero>(`/api/heroes/${encodeURIComponent(id)}/reset`, { method: 'POST' }),
  deleteHero: (id: string) => request<unknown>(`/api/heroes/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  // M8 8m admin auth (docs/design/runner-and-helpdesk.md section 5). `authStatus` is public (works with
  // no token, or a bad/expired one — the response just says `admin: false`); the rest need an existing
  // admin session, carried by the Authorization header `request()` attaches above.
  authStatus: () => request<AuthStatus>('/api/auth/status'),
  pair: (body: PairRequest) => request<AuthTokenResponse>('/api/auth/pair', { method: 'POST', body: json(body) }),
  bootstrap: (body: BootstrapRequest = {}) => request<AuthTokenResponse>('/api/auth/bootstrap', { method: 'POST', body: json(body) }),
  authSessions: () => request<AdminSessionInfo[]>('/api/auth/sessions'),
  revokeSession: (id: string) => request<{ ok: true }>(`/api/auth/sessions/${encodeURIComponent(id)}/revoke`, { method: 'POST' }),
  logout: () => request<{ ok: true }>('/api/auth/logout', { method: 'POST' }),
};
