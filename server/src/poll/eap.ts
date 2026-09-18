import { createHash } from 'node:crypto'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import { Agent as HttpAgent, request as httpRequest } from 'node:http'
import { normalizeMac } from '@shared/mac'
import type { RawAccessPoint, RawApRadio, RawApSsid, RawWirelessClient } from '../state/raw.js'
import { log } from '../logger.js'

const logger = log('eap')

/*
 * TP-Link Omada EAP in *standalone* mode (no controller). The AP has no SNMP
 * client table, but its web UI is a plain JSON API:
 *
 *   GET  /                                 → session cookie
 *   POST /  username=…&password=MD5(pw)    → 200 with an empty body on success,
 *                                            the login page HTML on failure
 *   GET  /data/<name>.json?operation=…     → { success, timeout, data }
 *
 * Every data request needs a `Referer` on the AP's own origin (CSRF guard) —
 * without it the AP answers `timeout: true` as if logged out. The AP allows a
 * single admin session: a new login (ours or a browser's) ends the previous one,
 * so the poller keeps its cookie and only logs in again when the AP says so.
 * Verified on EAP650 v3 firmware 1.5.6.
 */

export type HttpResponse = {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
}
export type HttpRequestInit = {
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
  timeoutMs: number
}
export type HttpClient = {
  request(url: string, init: HttpRequestInit): Promise<HttpResponse>
}

/** Keep-alive client that accepts the APs' self-signed certificates. */
export function createHttpClient(): HttpClient {
  const httpsAgent = new HttpsAgent({
    keepAlive: true,
    maxSockets: 2,
    rejectUnauthorized: false,
  })
  const httpAgent = new HttpAgent({ keepAlive: true, maxSockets: 2 })
  return {
    request(url, init) {
      return new Promise((resolve, reject) => {
        const target = new URL(url)
        const secure = target.protocol === 'https:'
        const req = (secure ? httpsRequest : httpRequest)(
          target,
          {
            method: init.method ?? 'GET',
            agent: secure ? httpsAgent : httpAgent,
            headers: {
              ...(init.headers ?? {}),
              ...(init.body !== undefined ? { 'content-length': String(Buffer.byteLength(init.body)) } : {}),
            },
            timeout: init.timeoutMs,
          },
          (response) => {
            const chunks: Buffer[] = []
            response.on('data', (chunk: Buffer) => chunks.push(chunk))
            response.on('end', () =>
              resolve({
                status: response.statusCode ?? 0,
                headers: response.headers,
                body: Buffer.concat(chunks).toString('utf8'),
              }),
            )
            response.on('error', reject)
          },
        )
        req.on('timeout', () => req.destroy(new Error(`timeout after ${init.timeoutMs} ms`)))
        req.on('error', reject)
        if (init.body !== undefined) req.write(init.body)
        req.end()
      })
    },
  }
}

export type EapCredentials = { username: string; password: string }

/** The web UI sends `MD5(password)` in upper-case hex (see `md5AndSha256Encrypt` in the AP's su.js). */
export const eapPasswordHash = (password: string) => createHash('md5').update(password, 'utf8').digest('hex').toUpperCase()

export class EapAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EapAuthError'
  }
}

type EapEnvelope = {
  success?: boolean
  timeout?: boolean | string
  error?: number
  errorcode?: string
  data?: unknown
}

const isTimedOut = (body: EapEnvelope) => body.timeout === true || body.timeout === 'true'

/** One AP's login session. Re-logs in transparently when the AP drops the session. */
export class EapSession {
  private cookie: string | null = null
  private loginPromise: Promise<void> | null = null

  constructor(
    readonly baseUrl: string,
    private readonly http: HttpClient,
    private readonly credentials: EapCredentials,
    private readonly timeoutMs: number,
  ) {}

  private headers(extra: Record<string, string> = {}) {
    return {
      accept: 'application/json, text/plain, */*',
      referer: `${this.baseUrl}/`,
      ...(this.cookie ? { cookie: this.cookie } : {}),
      ...extra,
    }
  }

  private rememberCookie(response: HttpResponse) {
    const raw = response.headers['set-cookie']
    const list = Array.isArray(raw) ? raw : raw ? [raw] : []
    for (const item of list) {
      const pair = item.split(';')[0]?.trim()
      if (pair?.startsWith('JSESSIONID=')) this.cookie = pair
    }
  }

  get loggedIn() {
    return this.cookie !== null
  }

  forget() {
    this.cookie = null
  }

  async login() {
    if (this.loginPromise) return this.loginPromise
    this.loginPromise = this.doLogin().finally(() => (this.loginPromise = null))
    return this.loginPromise
  }

  private async doLogin() {
    this.cookie = null
    const landing = await this.http.request(`${this.baseUrl}/`, {
      headers: this.headers(),
      timeoutMs: this.timeoutMs,
    })
    this.rememberCookie(landing)
    const body = new URLSearchParams({
      username: this.credentials.username,
      password: eapPasswordHash(this.credentials.password),
    }).toString()
    const response = await this.http.request(`${this.baseUrl}/`, {
      method: 'POST',
      headers: this.headers({
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'x-requested-with': 'XMLHttpRequest',
      }),
      body,
      timeoutMs: this.timeoutMs,
    })
    this.rememberCookie(response)
    // Success is a 200 with an empty body; a rejected login serves the login page again.
    if (response.status !== 200 || response.body.trim().length > 0 || !this.cookie) {
      this.cookie = null
      throw new EapAuthError(await this.describeLoginFailure())
    }
  }

  private async describeLoginFailure() {
    try {
      const response = await this.http.request(`${this.baseUrl}/data/login.json`, {
        method: 'POST',
        headers: this.headers({
          'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        }),
        body: 'operation=read',
        timeoutMs: this.timeoutMs,
      })
      const info = JSON.parse(response.body) as {
        error?: number
        retryChances?: number
        waitTime?: number
        dutMode?: string
      }
      if (info.error === 3 && typeof info.waitTime === 'number' && info.waitTime > 0) return `login locked by the AP for ${Math.ceil(info.waitTime / 60)} min after too many failed attempts`
      if (info.error === 1 && typeof info.retryChances === 'number') return `login rejected — check the AP username/password (${info.retryChances} attempts left before the AP locks)`
      if (info.dutMode) return 'login rejected — check the AP username/password'
    } catch {
      /* fall through */
    }
    return 'login rejected — not a standalone Omada EAP, or wrong username/password'
  }

  /** `GET /data/<endpoint>.json?operation=…`, logging in first (or again) when needed. */
  async data<T>(endpoint: string, params: Record<string, string | number>, retry = true): Promise<T> {
    if (!this.cookie) await this.login()
    const query = new URLSearchParams(Object.fromEntries(Object.entries(params).map(([key, value]) => [key, String(value)]))).toString()
    const response = await this.http.request(`${this.baseUrl}/data/${endpoint}.json?${query}`, {
      headers: this.headers({ 'x-requested-with': 'XMLHttpRequest' }),
      timeoutMs: this.timeoutMs,
    })
    if (response.status !== 200) throw new Error(`${endpoint}: HTTP ${response.status}`)
    let body: EapEnvelope
    try {
      body = JSON.parse(response.body) as EapEnvelope
    } catch {
      throw new Error(`${endpoint}: not JSON — is this a standalone Omada EAP?`)
    }
    if (isTimedOut(body)) {
      // Session ended (browser login elsewhere, AP reboot, idle timeout): log in once more, then give up.
      this.cookie = null
      if (!retry) throw new Error(`${endpoint}: session rejected right after login`)
      await this.login()
      return this.data<T>(endpoint, params, false)
    }
    if (body.success === false) throw new Error(`${endpoint}: AP error ${body.errorcode ?? body.error ?? 'unknown'}`)
    return body.data as T
  }
}

/* ------------------------------------------------------------ parsing */

export const RADIO_BANDS = ['2.4 GHz', '5 GHz', '5 GHz-2', '6 GHz'] as const
export const radioBand = (id: number | null): string | null => (id === null ? null : (RADIO_BANDS[id] ?? `radio ${id}`))

const SECURITY = ['open', 'WEP', 'WPA-Enterprise', 'WPA-Personal', 'PPSK', 'PPSK (RADIUS)']
export const securityLabel = (code: unknown) => (typeof code === 'number' && SECURITY[code] ? SECURITY[code] : code === undefined || code === null ? null : String(code))

/** `"44  / 5220MHz"` → channel 44 at 5220 MHz. Disabled radios report things like `"N/A"`. */
export function parseEapChannel(value: unknown): {
  channel: number | null
  frequencyMhz: number | null
} {
  if (typeof value !== 'string') return { channel: null, frequencyMhz: null }
  const match = value.match(/^\s*(\d+)\s*(?:\/\s*(\d+)\s*MHz)?/i)
  if (!match) return { channel: null, frequencyMhz: null }
  return {
    channel: Number(match[1]),
    frequencyMhz: match[2] ? Number(match[2]) : null,
  }
}

/** `"0 days 05:49:13"` → seconds. */
export function parseEapDuration(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const match = value.match(/(?:(\d+)\s*days?\s*)?(\d{1,2}):(\d{2}):(\d{2})/)
  if (!match) return null
  return Number(match[1] ?? 0) * 86400 + Number(match[2]) * 3600 + Number(match[3]) * 60 + Number(match[4])
}

/** Leading number of `"286.8Mbps"`, `"20dBm"`, `"160MHz"`, `"2401.0"`. */
export function parseEapNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const match = value.match(/-?\d+(?:\.\d+)?/)
  return match ? Number(match[0]) : null
}

const asNumber = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const asString = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null)

/* ------------------------------------------------------------ reading */

type Counters = { at: number; rx: number | null; tx: number | null }

/** Bytes/s between two counter samples; null across resets/wraps and when no previous sample exists. */
export function rate(previousAt: number | null, previousBytes: number | null, at: number, bytes: number | null): number | null {
  if (previousAt === null || previousBytes === null || bytes === null) return null
  const elapsed = (at - previousAt) / 1000
  if (elapsed <= 0 || bytes < previousBytes) return null
  return Math.round((bytes - previousBytes) / elapsed)
}

export type EapReading = {
  ap: Pick<RawAccessPoint, 'mac' | 'ip' | 'model' | 'firmware' | 'hardware' | 'uptimeSeconds' | 'cpuPercent' | 'memoryPercent' | 'lanLink' | 'ssids' | 'radios' | 'clients' | 'detailsAt'>
  clients: Omit<RawWirelessClient, 'source' | 'apId' | 'apName' | 'apMac' | 'at' | 'rxBps' | 'txBps'>[]
}

type EapDevice = {
  deviceName?: unknown
  deviceModel?: unknown
  firmwareVersion?: unknown
  hardwareVersion?: unknown
  mac?: unknown
  ip?: unknown
  uptime?: unknown
  cpu?: unknown
  memory?: unknown
  lan_port_list?: { status?: unknown; name?: unknown }[]
}
type EapRadio = {
  enable?: unknown
  channel?: unknown
  rate?: unknown
  power?: unknown
  chanWidth?: unknown
  mode?: unknown
}
type EapTraffic = { rx_bytes?: unknown; tx_bytes?: unknown }
type EapSsid = {
  SSID?: unknown
  Radio?: unknown
  vlan?: unknown
  security?: unknown
  guest?: unknown
  portal?: unknown
  clients?: unknown
}
type EapClient = {
  hostname?: unknown
  IP?: unknown
  MAC?: unknown
  Radio?: unknown
  SSID?: unknown
  RSSI?: unknown
  Rate?: unknown
  ActiveTime?: unknown
  Up?: unknown
  Down?: unknown
}

/**
 * Reads what the AP's Status pages show. The client and SSID lists are cheap
 * and change often; device info, radio settings and radio counters are only
 * refreshed when `details` is set (or nothing is known yet).
 */
export async function readEap(session: EapSession, options: { details: boolean; previous: RawAccessPoint | null }): Promise<EapReading> {
  const previous = options.previous
  const details = options.details || !previous || previous.radios.length === 0
  const ssidRows = (
    (await session.data<EapSsid[] | null>('status.wireless.ssid', {
      operation: 'load',
    })) ?? []
  ).filter((row) => row && typeof row === 'object')
  const clientRows = (
    (await session.data<EapClient[] | null>('status.client.user', {
      operation: 'load',
    })) ?? []
  ).filter((row) => row && typeof row === 'object')

  const ssids: RawApSsid[] = ssidRows
    .map((row) => ({
      ssid: asString(row.SSID) ?? '',
      radioId: asNumber(row.Radio) ?? 0,
      vlanId: asNumber(row.vlan) || null,
      security: securityLabel(row.security),
      guest: row.guest === true,
      portal: row.portal === true,
      clients: asNumber(row.clients) ?? 0,
    }))
    .filter((row) => row.ssid)
  const vlanBySsid = new Map<string, number | null>()
  for (const row of ssids) if (!vlanBySsid.has(row.ssid) || vlanBySsid.get(row.ssid) === null) vlanBySsid.set(row.ssid, row.vlanId)

  const clients: EapReading['clients'] = []
  for (const row of clientRows) {
    const mac = normalizeMac(String(row.MAC ?? ''))
    if (!mac) continue
    const ssid = asString(row.SSID)
    const radioId = asNumber(row.Radio)
    clients.push({
      mac,
      ip: asString(row.IP),
      hostname: asString(row.hostname),
      ssid,
      radioId,
      band: radioBand(radioId),
      vlanId: ssid ? (vlanBySsid.get(ssid) ?? null) : null,
      signal: asNumber(row.RSSI) ?? parseEapNumber(row.RSSI),
      rateMbps: parseEapNumber(row.Rate),
      connectedSeconds: parseEapDuration(row.ActiveTime),
      // `Down` is what the AP sent to the client, `Up` what it received — from the client's point of view.
      rxBytes: asNumber(row.Down),
      txBytes: asNumber(row.Up),
    })
  }

  // Which radios exist follows from the SSID list (an EAP650 has 0 and 1; tri-band models add 2 or 3).
  const radioIds = [...new Set([...ssids.map((row) => row.radioId), ...(previous?.radios.map((radio) => radio.id) ?? [])])].sort((a, b) => a - b)
  if (radioIds.length === 0) radioIds.push(0, 1)
  const clientsPerRadio = new Map<number, number>()
  for (const client of clients) if (client.radioId !== null) clientsPerRadio.set(client.radioId, (clientsPerRadio.get(client.radioId) ?? 0) + 1)

  let device: EapDevice | null = null
  let radios: RawApRadio[]
  if (details) {
    device = (await session.data<EapDevice>('status.device', { operation: 'read' })) ?? {}
    radios = []
    for (const id of radioIds) {
      const radio =
        (await session.data<EapRadio>('status.wireless.radio', {
          operation: 'read',
          radioID: id,
        })) ?? {}
      const traffic =
        (await session.data<EapTraffic>('status.traffic.radio', {
          operation: 'read',
          radioID: id,
          type: 'radio',
        })) ?? {}
      const before = previous?.radios.find((item) => item.id === id)
      const { channel, frequencyMhz } = parseEapChannel(radio.channel)
      radios.push({
        id,
        band: radioBand(id) ?? `radio ${id}`,
        enabled: typeof radio.enable === 'string' ? /enable/i.test(radio.enable) : radio.enable !== false,
        channel,
        frequencyMhz,
        widthMhz: parseEapNumber(radio.chanWidth),
        mode: asString(radio.mode),
        txPowerDbm: parseEapNumber(radio.power),
        maxRateMbps: parseEapNumber(radio.rate),
        clients: clientsPerRadio.get(id) ?? 0,
        rxBytes: asNumber(traffic.rx_bytes),
        txBytes: asNumber(traffic.tx_bytes),
        rxBps: before ? rate(previous?.detailsAt ?? null, before.rxBytes, Date.now(), asNumber(traffic.rx_bytes)) : null,
        txBps: before ? rate(previous?.detailsAt ?? null, before.txBytes, Date.now(), asNumber(traffic.tx_bytes)) : null,
      })
    }
  } else {
    radios = (previous?.radios ?? []).map((radio) => ({
      ...radio,
      clients: clientsPerRadio.get(radio.id) ?? 0,
    }))
  }

  const lan = device?.lan_port_list?.[0]
  return {
    ap: {
      mac: device ? normalizeMac(String(device.mac ?? '')) || null : (previous?.mac ?? null),
      ip: device ? asString(device.ip) : (previous?.ip ?? null),
      model: device ? asString(device.deviceModel) : (previous?.model ?? null),
      firmware: device ? asString(device.firmwareVersion) : (previous?.firmware ?? null),
      hardware: device ? asString(device.hardwareVersion) : (previous?.hardware ?? null),
      uptimeSeconds: device ? parseEapDuration(device.uptime) : (previous?.uptimeSeconds ?? null),
      cpuPercent: device ? asNumber(device.cpu) : (previous?.cpuPercent ?? null),
      memoryPercent: device ? asNumber(device.memory) : (previous?.memoryPercent ?? null),
      lanLink: lan ? [asString(lan.name), asString(lan.status)].filter(Boolean).join(' ') || null : (previous?.lanLink ?? null),
      ssids,
      radios,
      clients: clients.length,
      detailsAt: details ? Date.now() : (previous?.detailsAt ?? null),
    },
    clients,
  }
}

/* ------------------------------------------------------------- poller */

export type EapTarget = { id: string; name: string; host: string }

const AUTH_BACKOFF_MS = 10 * 60_000
const FAILURE_BACKOFF_MS = [0, 0, 30_000, 60_000, 120_000, 300_000]

type ApState = {
  session: EapSession
  failures: number
  nextAttemptAt: number
  cycles: number
  clientCounters: Map<string, Counters>
}

/** Per-AP sessions, back-off and throughput history for the standalone EAP poller. */
export class EapPoller {
  private readonly aps = new Map<string, ApState>()

  constructor(private readonly http: HttpClient) {}

  /** Drops sessions so new credentials/timeouts apply immediately (and a locked-out back-off ends when the user fixes the password). */
  reset() {
    this.aps.clear()
  }

  private stateFor(target: EapTarget, credentials: EapCredentials, timeoutMs: number): ApState {
    let state = this.aps.get(target.id)
    if (!state || state.session.baseUrl !== `https://${target.host}`) {
      state = {
        session: new EapSession(`https://${target.host}`, this.http, credentials, timeoutMs),
        failures: 0,
        nextAttemptAt: 0,
        cycles: 0,
        clientCounters: new Map(),
      }
      this.aps.set(target.id, state)
    }
    return state
  }

  /**
   * Polls one AP into `accessPoints` / `wirelessClients`. Returns false when the
   * AP is in a back-off window (nothing was asked). Throws after recording the
   * failure so the scheduler shows it.
   */
  async poll(
    target: EapTarget,
    options: {
      credentials: EapCredentials
      timeoutMs: number
      detailEvery: number
    },
    sink: {
      accessPoints: Map<string, RawAccessPoint>
      wirelessClients: Map<string, RawWirelessClient>
    },
  ): Promise<boolean> {
    const state = this.stateFor(target, options.credentials, options.timeoutMs)
    const now = Date.now()
    if (now < state.nextAttemptAt) return false
    const previous = sink.accessPoints.get(target.id) ?? null
    const started = Date.now()
    try {
      const reading = await readEap(state.session, {
        details: state.cycles % Math.max(1, options.detailEvery) === 0,
        previous,
      })
      const at = Date.now()
      state.cycles += 1
      state.failures = 0
      state.nextAttemptAt = 0
      sink.accessPoints.set(target.id, {
        id: target.id,
        source: 'eap',
        name: target.name,
        status: 'online',
        ...reading.ap,
        at,
        lastOkAt: at,
        lastError: null,
        lastDurationMs: at - started,
      })
      // Replace this AP's clients; a client that roamed to another AP is overwritten by that AP's poll.
      for (const [mac, client] of sink.wirelessClients) if (client.source === 'eap' && client.apId === target.id) sink.wirelessClients.delete(mac)
      const seen = new Set<string>()
      for (const client of reading.clients) {
        seen.add(client.mac)
        const counters = state.clientCounters.get(client.mac)
        const other = sink.wirelessClients.get(client.mac)
        // Keep the newest association when two APs both still list the same client (roaming hand-over).
        if (other && other.source === 'eap' && other.at > at) continue
        sink.wirelessClients.set(client.mac, {
          ...client,
          source: 'eap',
          apId: target.id,
          apName: target.name,
          apMac: reading.ap.mac,
          rxBps: rate(counters?.at ?? null, counters?.rx ?? null, at, client.rxBytes),
          txBps: rate(counters?.at ?? null, counters?.tx ?? null, at, client.txBytes),
          at,
        })
        state.clientCounters.set(client.mac, {
          at,
          rx: client.rxBytes,
          tx: client.txBytes,
        })
      }
      for (const mac of state.clientCounters.keys()) if (!seen.has(mac)) state.clientCounters.delete(mac)
      return true
    } catch (error) {
      const at = Date.now()
      const message = error instanceof Error ? error.message : String(error)
      state.failures += 1
      if (error instanceof EapAuthError) {
        // Every rejected login burns one of the AP's ~30 attempts before it locks the admin out — wait a long time.
        state.nextAttemptAt = at + AUTH_BACKOFF_MS
        logger.warn(`${target.name}: ${message}; not retrying for ${AUTH_BACKOFF_MS / 60_000} min`)
      } else {
        state.session.forget()
        state.nextAttemptAt = at + (FAILURE_BACKOFF_MS[Math.min(state.failures, FAILURE_BACKOFF_MS.length - 1)] ?? 0)
        logger.debug(`${target.name}: ${message}`)
      }
      sink.accessPoints.set(target.id, {
        ...(previous ?? {
          id: target.id,
          source: 'eap',
          name: target.name,
          mac: null,
          ip: target.host,
          model: null,
          firmware: null,
          hardware: null,
          uptimeSeconds: null,
          cpuPercent: null,
          memoryPercent: null,
          lanLink: null,
          clients: 0,
          ssids: [],
          radios: [],
          lastOkAt: null,
          detailsAt: null,
          lastDurationMs: null,
        }),
        status: 'unknown',
        at,
        lastError: message,
      })
      throw error
    }
  }
}
