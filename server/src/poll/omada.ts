import { request as httpsRequest } from 'node:https'
import { request as httpRequest } from 'node:http'
import { normalizeMac } from '@shared/mac'
import { RADIO_BANDS, radioBand } from './eap.js'
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
 * Optional: TP-Link Omada controller Open API (v5.9+) for sites that run a
 * controller. Standalone EAPs are read directly instead (see eap.ts); both
 * feed the same `accessPoints` / `wirelessClients` maps, tagged by source.
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
    for (const [id, ap] of store.accessPoints) if (ap.source === 'omada') store.accessPoints.delete(id)
    const apNames = new Map<string, string>()
    for (const ap of aps.data ?? []) {
      const mac = normalizeMac(String(ap.mac ?? ''))
      if (!mac) continue
      const radios = (ap.radioTrafficList as Record<string, unknown>[] | undefined) ?? []
      const name = String(ap.name ?? mac)
      apNames.set(mac, name)
      const ssids = ((ap.wirelessLinkedList ?? ap.ssidList) as Record<string, unknown>[] | undefined) ?? []
      store.accessPoints.set(mac, {
        id: mac,
        source: 'omada',
        mac,
        ip: typeof ap.ip === 'string' ? ap.ip : null,
        name,
        model: typeof ap.model === 'string' ? ap.model : null,
        firmware: typeof ap.firmwareVersion === 'string' ? ap.firmwareVersion : null,
        hardware: typeof ap.hwVersion === 'string' ? ap.hwVersion : null,
        status: Number(ap.status) === 1 ? 'online' : Number(ap.status) === 0 ? 'offline' : 'unknown',
        uptimeSeconds: typeof ap.uptimeLong === 'number' ? ap.uptimeLong : null,
        cpuPercent: typeof ap.cpuUtil === 'number' ? ap.cpuUtil : null,
        memoryPercent: typeof ap.memUtil === 'number' ? ap.memUtil : null,
        lanLink: null,
        clients: Number(ap.clientNum ?? 0),
        ssids: ssids
          .filter((item) => typeof item.ssid === 'string')
          .map((item) => ({ ssid: String(item.ssid), radioId: Number(item.radioId ?? 0), vlanId: typeof item.vlanId === 'number' && item.vlanId > 0 ? item.vlanId : null, security: null, guest: item.guestNetEnable === true, portal: false, clients: 0 })),
        radios: radios.map((radio, index) => ({
          id: index,
          band: RADIO_BANDS[index] ?? `radio ${index}`,
          enabled: true,
          channel: typeof radio.channel === 'number' ? radio.channel : null,
          frequencyMhz: null,
          widthMhz: null,
          mode: null,
          txPowerDbm: typeof radio.txPower === 'number' ? radio.txPower : null,
          maxRateMbps: null,
          clients: Number(radio.clientNum ?? 0),
          rxBytes: typeof radio.rx === 'number' ? radio.rx : null,
          txBytes: typeof radio.tx === 'number' ? radio.tx : null,
          rxBps: null,
          txBps: null,
        })),
        at: now,
        lastOkAt: now,
        detailsAt: now,
        lastError: null,
        lastDurationMs: null,
      })
    }
    for (const [mac, client] of store.wirelessClients) if (client.source === 'omada') store.wirelessClients.delete(mac)
    for (const client of clients.data ?? []) {
      const mac = normalizeMac(String(client.mac ?? ''))
      if (!mac || !client.wireless) continue
      const apMac = normalizeMac(String(client.apMac ?? '')) || null
      const radioId = typeof client.radioId === 'number' ? client.radioId : null
      store.wirelessClients.set(mac, {
        mac,
        source: 'omada',
        ip: typeof client.ip === 'string' ? client.ip : null,
        hostname: typeof client.name === 'string' ? client.name : null,
        apId: apMac ?? 'omada',
        apName: typeof client.apName === 'string' ? client.apName : (apMac ? (apNames.get(apMac) ?? null) : null),
        apMac,
        ssid: typeof client.ssid === 'string' ? client.ssid : null,
        radioId,
        band: radioBand(radioId),
        vlanId: typeof client.vid === 'number' && client.vid > 0 ? client.vid : null,
        signal: typeof client.rssi === 'number' ? client.rssi : null,
        rateMbps: typeof client.rxRate === 'number' ? client.rxRate / 1000 : null,
        connectedSeconds: typeof client.uptime === 'number' ? client.uptime : null,
        rxBytes: typeof client.trafficDown === 'number' ? client.trafficDown : null,
        txBytes: typeof client.trafficUp === 'number' ? client.trafficUp : null,
        rxBps: null,
        txBps: null,
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
