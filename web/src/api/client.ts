import type { KnownDeviceMeta, MonitorEvent, MonitorState, PublicSettings, ScanScope, ScanStatus, TrafficState } from '@shared/types'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: { accept: 'application/json', ...(init?.body ? { 'content-type': 'application/json' } : {}), ...(init?.headers ?? {}) },
  })
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`
    try {
      const body = (await response.json()) as { error?: string; issues?: { message: string; path: (string | number)[] }[] }
      if (body.issues?.length) message = body.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')
      else if (body.error) message = body.error
    } catch {
      /* not JSON */
    }
    throw new Error(message)
  }
  return (await response.json()) as T
}

export const api = {
  state: () => request<MonitorState>('/state'),
  traffic: () => request<TrafficState>('/traffic'),
  eventsHistory: (limit: number) => request<MonitorEvent[]>(`/events/history?limit=${limit}`),
  scanStatus: () => request<ScanStatus>('/scan/status'),
  requestScan: (scope: ScanScope) => request<{ queued: string[]; status: ScanStatus }>('/scan/request', { method: 'POST', body: JSON.stringify({ scope }) }),
  saveMeta: (id: string, meta: Partial<KnownDeviceMeta>) =>
    request<KnownDeviceMeta>(`/devices/${encodeURIComponent(id)}/meta`, { method: 'PUT', body: JSON.stringify(meta) }),
  deleteMeta: (id: string) => request<{ ok: true }>(`/devices/${encodeURIComponent(id)}/meta`, { method: 'DELETE' }),
  setInUse: (id: string, inUse: boolean) => request<{ ok: true; inUse: boolean }>(`/infra/${encodeURIComponent(id)}/use`, { method: 'PUT', body: JSON.stringify({ inUse }) }),
  resetSetup: () => request<{ ok: true }>('/setup/reset', { method: 'POST' }),
  resolveProblem: (id: string) => request<{ ok: true; message: string }>(`/problems/${encodeURIComponent(id)}/resolve`, { method: 'POST' }),
  settings: () => request<PublicSettings>('/settings'),
  saveSettings: (patch: unknown) => request<PublicSettings>('/settings', { method: 'PUT', body: JSON.stringify(patch) }),
  setManagementIp: (id: string, managementIp: string) => request<{ ok: true }>(`/inventory/devices/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ managementIp }) }),
  uploadInventory: (json: unknown) => request<{ ok: true; projectName: string; devices: number }>('/inventory', { method: 'POST', body: JSON.stringify(json) }),
  syncInventory: () => request<{ ok: true; projectName: string; devices: number; revision: number | null; queued: string[] }>('/inventory/sync', { method: 'POST' }),
  importBackup: (json: unknown) => request<{ ok: true; settings: boolean; knownDevices: number }>('/import', { method: 'POST', body: JSON.stringify(json) }),
  exportUrl: '/api/export',
}
