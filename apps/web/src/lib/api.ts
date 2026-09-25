import type { OfficeEvent, OfficeSnapshot, Project, Role, Settings, SettingsPatch } from '@tagconn/shared';

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
    // The server only accepts JSON bodies on writes (415 otherwise), even for body-less actions.
    const res = await fetch(path, {
      ...init,
      body: write ? (init?.body ?? '{}') : undefined,
      signal: ctrl.signal,
      headers: { ...(write ? { 'content-type': 'application/json' } : {}), ...init?.headers },
    });
    const text = await res.text();
    const body: unknown = text ? JSON.parse(text) : undefined;
    if (!res.ok) {
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
};
