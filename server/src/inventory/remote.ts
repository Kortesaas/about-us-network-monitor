import { z } from 'zod'
import type { Settings } from '@shared/types'

const sessionSchema = z.object({
  authenticated: z.boolean().default(false),
  configured: z.boolean().default(false),
  secure: z.boolean().default(false),
})

const projectResponseSchema = z.object({
  project: z.unknown().nullable().optional(),
  revision: z.number().int().nullable().optional(),
})

type NetworkConfigSettings = Settings['networkConfig']

export class RemoteInventoryError extends Error {
  constructor(
    message: string,
    public readonly status = 502,
  ) {
    super(message)
    this.name = 'RemoteInventoryError'
  }
}

export type RemoteInventoryProject = {
  project: unknown
  revision: number | null
  sourceUrl: string
}

export async function fetchRemoteInventoryProject(settings: NetworkConfigSettings): Promise<RemoteInventoryProject> {
  if (!settings.enabled) throw new RemoteInventoryError('Network config sync is disabled.', 400)
  if (!settings.baseUrl.trim()) throw new RemoteInventoryError('Network config URL is not set.', 400)
  if (!settings.username.trim()) throw new RemoteInventoryError('Network config username is not set.', 400)
  if (!settings.password) throw new RemoteInventoryError('Network config password is not set.', 400)

  const client = new RemoteNetworkConfigClient(settings)
  const session = sessionSchema.parse(
    await client.request('api/session.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: settings.username, password: settings.password }),
    }),
  )
  if (!session.configured) throw new RemoteInventoryError('Network config sign-in is not configured on the remote site.', 502)
  if (!session.secure) throw new RemoteInventoryError('Network config sign-in requires HTTPS on the remote site.', 502)
  if (!session.authenticated) throw new RemoteInventoryError('Network config sign-in failed.', 401)

  const projectResponse = parseProjectResponse(await client.request('api/project.php'))
  if (!projectResponse.project) throw new RemoteInventoryError('The remote network config has no published project yet.', 404)
  return { project: projectResponse.project, revision: projectResponse.revision ?? null, sourceUrl: client.url('api/project.php') }
}

export function parseProjectResponse(raw: unknown) {
  const response = projectResponseSchema.parse(raw)
  return { project: response.project ?? null, revision: response.revision ?? null }
}

class RemoteNetworkConfigClient {
  private cookie = ''
  private readonly baseUrl: URL

  constructor(private readonly settings: NetworkConfigSettings) {
    const trimmed = settings.baseUrl.trim()
    this.baseUrl = new URL(trimmed.endsWith('/') ? trimmed : `${trimmed}/`)
  }

  url(path: string) {
    return new URL(path.replace(/^\/+/, ''), this.baseUrl).toString()
  }

  async request(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers)
    headers.set('Accept', headers.get('Accept') ?? 'application/json')
    if (this.cookie) headers.set('Cookie', this.cookie)

    let response: Response
    try {
      response = await fetch(this.url(path), {
        ...init,
        headers,
        signal: AbortSignal.timeout(this.settings.timeoutMs),
      })
    } catch (error) {
      if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError'))
        throw new RemoteInventoryError(`Network config request timed out after ${this.settings.timeoutMs} ms.`, 504)
      throw new RemoteInventoryError(error instanceof Error ? error.message : 'Could not reach network config.', 502)
    }

    const setCookie = response.headers.get('set-cookie')
    if (setCookie) this.cookie = setCookie.split(';')[0] ?? ''

    const body = await response.json().catch(() => null)
    if (!response.ok) throw new RemoteInventoryError(errorMessage(body, response.statusText), response.status)
    return body
  }
}

function errorMessage(body: unknown, fallback: string) {
  if (body && typeof body === 'object') {
    const data = body as { error?: { message?: unknown } | string; message?: unknown }
    if (typeof data.error === 'string') return data.error
    if (data.error && typeof data.error.message === 'string') return data.error.message
    if (typeof data.message === 'string') return data.message
  }
  return fallback || 'The shared project service is unavailable.'
}
