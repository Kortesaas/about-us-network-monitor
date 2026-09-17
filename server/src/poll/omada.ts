import { request as httpsRequest } from 'node:https'
import { request as httpRequest } from 'node:http'
import { normalizeMac } from '@shared/mac'
import type { Store } from '../state/store.js'
import { log } from '../logger.js'

const logger = log('omada')

type Token = { value: string; expiresAt: number }
let token: Token | null = null

/** Minimal JSON client on node:http(s) so self-signed controller certificates can be allowed per request. */
function requestJson(url: string, options: { method?: string; headers?: Record<string, string>; body?: string; insecureTls: boolean }) {
  return new Promise<{ errorCode?: number; msg?: string; result?: unknown }>((resolve, reject) => {
    const target = new URL(url)
    const impl = target.protocol === 'http:' ? httpRequest : httpsRequest
    const req = impl(
      target,
      {
        method: options.method ?? 'GET',
        headers: { accept: 'application/json', ...(options.headers ?? {}), ...(options.body ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(options.body)) } : {}) },
        rejectUnauthorized: !options.insecureTls,
        timeout: 8000,
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
          } catch (error) {
            reject(error)
          }
        })
      },
    )
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    if (options.body) req.write(options.body)
    req.end()
  })
}

/**
 * Optional: TP-Link Omada controller Open API (v5.9+). Standalone EAPs have
 * no API, so this only fills in Wi-Fi client / radio info when a controller
 * with an Open API client is configured in Settings.
 */
export async function pollOmada(store: Store) {
  const cfg = store.settings.omada
  if (!cfg.enabled || !cfg.baseUrl || !cfg.clientId || !cfg.clientSecret || !cfg.omadacId || !cfg.siteId) {
    store.omadaError = 'Omada is enabled but not fully configured'
    return
  }
  const base = cfg.baseUrl.replace(/\/+$/, '')
  const fetchJson = async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    const body = await requestJson(url, { ...init, insecureTls: cfg.insecureTls })
    if (body.errorCode && body.errorCode !== 0) throw new Error(body.msg ?? `Omada error ${body.errorCode}`)
    return body.result as Record<string, unknown>
  }
  try {
    if (!token || Date.now() > token.expiresAt) {
      const result = await fetchJson(`${base}/openapi/authorize/token?grant_type=client_credentials`, {
        method: 'POST',
        body: JSON.stringify({ omadacId: cfg.omadacId, client_id: cfg.clientId, client_secret: cfg.clientSecret }),
      })
      token = { value: String(result.accessToken), expiresAt: Date.now() + (Number(result.expiresIn ?? 3600) - 60) * 1000 }
    }
    const headers = { Authorization: `AccessToken=${token.value}` }
    const aps = (await fetchJson(`${base}/openapi/v1/${cfg.omadacId}/sites/${cfg.siteId}/aps?page=1&pageSize=100`, { headers })) as { data?: Record<string, unknown>[] }
    const clients = (await fetchJson(`${base}/openapi/v1/${cfg.omadacId}/sites/${cfg.siteId}/clients?page=1&pageSize=1000&filters.active=true`, { headers })) as { data?: Record<string, unknown>[] }
    const now = Date.now()
    store.accessPoints.clear()
    for (const ap of aps.data ?? []) {
      const mac = normalizeMac(String(ap.mac ?? ''))
      if (!mac) continue
      const radios = (ap.radioTrafficList as Record<string, unknown>[] | undefined) ?? []
      store.accessPoints.set(mac, {
        mac,
        ip: typeof ap.ip === 'string' ? ap.ip : null,
        name: String(ap.name ?? mac),
        status: Number(ap.status) === 1 ? 'online' : Number(ap.status) === 0 ? 'offline' : 'unknown',
        clients: Number(ap.clientNum ?? 0),
        ssids: [],
        radios: radios.map((radio, index) => ({ band: ['2.4 GHz', '5 GHz', '6 GHz'][index] ?? `radio ${index}`, channel: null, clients: Number(radio.clientNum ?? 0) })),
        at: now,
      })
    }
    store.wirelessClients.clear()
    for (const client of clients.data ?? []) {
      const mac = normalizeMac(String(client.mac ?? ''))
      if (!mac || !client.wireless) continue
      store.wirelessClients.set(mac, {
        mac,
        ip: typeof client.ip === 'string' ? client.ip : null,
        hostname: typeof client.name === 'string' ? client.name : null,
        apName: typeof client.apName === 'string' ? client.apName : null,
        apMac: normalizeMac(String(client.apMac ?? '')),
        ssid: typeof client.ssid === 'string' ? client.ssid : null,
        band: client.radioId === 0 ? '2.4 GHz' : client.radioId === 1 ? '5 GHz' : client.radioId === 2 ? '6 GHz' : null,
        signal: typeof client.rssi === 'number' ? client.rssi : null,
        at: now,
      })
    }
    store.omadaAt = now
    store.omadaError = null
  } catch (error) {
    token = null
    store.omadaError = error instanceof Error ? error.message : String(error)
    logger.warn(`poll failed: ${store.omadaError}`)
    throw error
  }
}
