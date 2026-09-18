import { describe, expect, it } from 'vitest'
import {
  EapAuthError,
  EapPoller,
  EapSession,
  eapPasswordHash,
  parseEapChannel,
  parseEapDuration,
  parseEapNumber,
  rate,
  type HttpClient,
  type HttpRequestInit,
  type HttpResponse,
} from '../src/poll/eap.js'
import type { RawAccessPoint, RawWirelessClient } from '../src/state/raw.js'

describe('EAP web API parsing', () => {
  it('hashes the password like the AP login page (upper-case MD5)', () => {
    expect(eapPasswordHash('admin')).toBe('21232F297A57A5A743894A0E4A801FC3')
  })

  it('parses the radio channel field', () => {
    expect(parseEapChannel('44  / 5220MHz')).toEqual({
      channel: 44,
      frequencyMhz: 5220,
    })
    expect(parseEapChannel('1   / 2412MHz')).toEqual({
      channel: 1,
      frequencyMhz: 2412,
    })
    expect(parseEapChannel('N/A')).toEqual({
      channel: null,
      frequencyMhz: null,
    })
    expect(parseEapChannel(undefined)).toEqual({
      channel: null,
      frequencyMhz: null,
    })
  })

  it('parses uptime / active time and unit-suffixed numbers', () => {
    expect(parseEapDuration('0 days 05:49:13')).toBe(5 * 3600 + 49 * 60 + 13)
    expect(parseEapDuration('2 days 00:00:01')).toBe(2 * 86400 + 1)
    expect(parseEapDuration('garbage')).toBeNull()
    expect(parseEapNumber('286.8Mbps')).toBe(286.8)
    expect(parseEapNumber('27dBm')).toBe(27)
    expect(parseEapNumber('160MHz')).toBe(160)
    expect(parseEapNumber('2401.0')).toBe(2401)
    expect(parseEapNumber(-48)).toBe(-48)
    expect(parseEapNumber(null)).toBeNull()
  })

  it('derives byte rates only from monotonically growing counters', () => {
    expect(rate(1000, 100, 11_000, 1100)).toBe(100)
    expect(rate(null, null, 11_000, 1100)).toBeNull()
    expect(rate(1000, 5000, 11_000, 100)).toBeNull()
    expect(rate(1000, 100, 1000, 200)).toBeNull()
  })
})

/**
 * A fake EAP that behaves like the real EAP650 firmware 1.5.6: cookie from
 * `GET /`, `POST /` answers 200+empty on success or the login page on failure,
 * data endpoints demand the newest session cookie and a same-origin referer.
 */
function fakeAp(
  options: { password: string; clients?: Record<string, unknown>[] } = {
    password: 'secret',
  },
) {
  const calls: string[] = []
  let session: string | null = null
  let logins = 0
  const loginPage = '<!DOCTYPE html><html><head><title>Login</title></head><body id="login-body"></body></html>'
  const json = (data: unknown): HttpResponse => ({
    status: 200,
    headers: {},
    body: JSON.stringify({ error: 0, success: true, timeout: 'false', data }),
  })
  const http: HttpClient = {
    async request(url: string, init: HttpRequestInit) {
      const target = new URL(url)
      calls.push(`${init.method ?? 'GET'} ${target.pathname}${target.search}`)
      if (target.pathname === '/') {
        if (init.method === 'POST') {
          logins += 1
          const form = new URLSearchParams(init.body ?? '')
          if (form.get('username') === 'admin' && form.get('password') === eapPasswordHash(options.password)) {
            session = `s${logins}`
            return {
              status: 200,
              headers: {
                'set-cookie': [`JSESSIONID=${session}; Path=/; HttpOnly; Secure=true`],
              },
              body: '',
            }
          }
          return { status: 200, headers: {}, body: loginPage }
        }
        return {
          status: 200,
          headers: { 'set-cookie': ['JSESSIONID=landing; Path=/'] },
          body: loginPage,
        }
      }
      if (target.pathname === '/data/login.json')
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            error: 1,
            dutMode: 'EAP650',
            retryChances: 29,
            waitTime: 0,
          }),
        }
      const cookie = init.headers?.cookie?.match(/JSESSIONID=([^;]+)/)?.[1]
      if (!session || cookie !== session || init.headers?.referer !== `${target.origin}/`)
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            success: true,
            timeout: true,
            mode: 'accessPoint',
            devInfo: 'EAP650',
          }),
        }
      switch (target.pathname) {
        case '/data/status.device.json':
          return json({
            deviceName: 'EAP650-D4-D6-DF-B6-55-56',
            deviceModel: 'EAP650',
            firmwareVersion: '1.5.6 Build 20260629 Rel. 20690(4555)',
            hardwareVersion: '3.0',
            mac: 'D4-D6-DF-B6-55-56',
            ip: '192.168.99.30',
            lan_port_list: [{ status: '1000Mbps - FD', name: 'ETH(PoE)' }],
            uptime: '0 days 05:49:13',
            cpu: 1,
            memory: 36,
          })
        case '/data/status.wireless.radio.json':
          return json(
            target.searchParams.get('radioID') === '0'
              ? {
                  enable: 'Enable',
                  channel: '1   / 2412MHz',
                  rate: '286.8Mbps',
                  power: '20dBm',
                  chanWidth: '20MHz',
                  mode: 'b/g/n/ax mixed',
                }
              : {
                  enable: 'Enable',
                  channel: '44  / 5220MHz',
                  rate: '2402.0Mbps',
                  power: '27dBm',
                  chanWidth: '160MHz',
                  mode: 'a/n/ac/ax mixed',
                },
          )
        case '/data/status.traffic.radio.json':
          return json({
            rx_packets: 0,
            tx_packets: 0,
            rx_bytes: 4726452,
            tx_bytes: 102001570,
            rx_dropped: 0,
            tx_dropped: 0,
            rx_errors: 0,
            tx_errors: 0,
          })
        case '/data/status.wireless.ssid.json':
          return {
            status: 200,
            headers: {},
            body: JSON.stringify({
              success: true,
              timeout: false,
              data: [0, 1].flatMap((radio) => [
                {
                  SSID: 'ABOUTUS-Control',
                  key: 2,
                  vlan: 10,
                  guest: false,
                  Radio: radio,
                  portal: false,
                  security: 3,
                  downTh: 0,
                  upTh: 0,
                  clients: 0,
                },
                {
                  SSID: 'ABOUTUS-MGMT',
                  key: 3,
                  vlan: 0,
                  guest: false,
                  Radio: radio,
                  portal: false,
                  security: 3,
                  downTh: 0,
                  upTh: 0,
                  clients: 0,
                },
              ]),
            }),
          }
        case '/data/status.client.user.json':
          return json(
            options.clients ?? [
              {
                key: 0,
                hostname: 'OPPO-Find-X9',
                Radio: 1,
                MAC: '9C-AA-5D-9A-FC-8F',
                IP: '192.168.99.159',
                SSID: 'ABOUTUS-MGMT',
                RSSI: -48,
                Rate: '2401.0',
                ActiveTime: '0 days 00:15:39',
                limit: 0,
                Down: 106356119,
                Up: 6264334,
              },
            ],
          )
        default:
          return { status: 404, headers: {}, body: '404' }
      }
    },
  }
  return { http, calls, logins: () => logins, kick: () => (session = null) }
}

const sink = () => ({
  accessPoints: new Map<string, RawAccessPoint>(),
  wirelessClients: new Map<string, RawWirelessClient>(),
})
const target = { id: 'ap-foh', name: 'AP Manu FOH', host: '192.168.99.30' }
const options = {
  credentials: { username: 'admin', password: 'secret' },
  timeoutMs: 1000,
  detailEvery: 6,
}

describe('EapSession', () => {
  it('logs in, sends the referer and keeps the session across requests', async () => {
    const ap = fakeAp()
    const session = new EapSession('https://192.168.99.30', ap.http, { username: 'admin', password: 'secret' }, 1000)
    const device = await session.data<{ mac: string }>('status.device', {
      operation: 'read',
    })
    expect(device.mac).toBe('D4-D6-DF-B6-55-56')
    await session.data('status.client.user', { operation: 'load' })
    expect(ap.logins()).toBe(1)
    expect(ap.calls).toEqual(['GET /', 'POST /', 'GET /data/status.device.json?operation=read', 'GET /data/status.client.user.json?operation=load'])
  })

  it('logs in again exactly once when the AP ends the session', async () => {
    const ap = fakeAp()
    const session = new EapSession('https://192.168.99.30', ap.http, { username: 'admin', password: 'secret' }, 1000)
    await session.data('status.device', { operation: 'read' })
    ap.kick()
    await session.data('status.device', { operation: 'read' })
    expect(ap.logins()).toBe(2)
  })

  it('reports a rejected login with the AP’s remaining attempts', async () => {
    const ap = fakeAp()
    const session = new EapSession('https://192.168.99.30', ap.http, { username: 'admin', password: 'wrong' }, 1000)
    await expect(session.data('status.device', { operation: 'read' })).rejects.toBeInstanceOf(EapAuthError)
    await expect(session.data('status.device', { operation: 'read' })).rejects.toThrow(/29 attempts left/)
  })
})

describe('EapPoller', () => {
  it('fills the AP and its clients from one poll', async () => {
    const ap = fakeAp()
    const poller = new EapPoller(ap.http)
    const store = sink()
    expect(await poller.poll(target, options, store)).toBe(true)
    const raw = store.accessPoints.get('ap-foh')!
    expect(raw).toMatchObject({
      source: 'eap',
      mac: 'd4:d6:df:b6:55:56',
      model: 'EAP650',
      uptimeSeconds: 20953,
      lanLink: 'ETH(PoE) 1000Mbps - FD',
      clients: 1,
      lastError: null,
    })
    expect(raw.radios.map((radio) => [radio.band, radio.channel, radio.widthMhz, radio.txPowerDbm, radio.clients])).toEqual([
      ['2.4 GHz', 1, 20, 20, 0],
      ['5 GHz', 44, 160, 27, 1],
    ])
    expect(raw.ssids.filter((ssid) => ssid.ssid === 'ABOUTUS-Control').map((ssid) => ssid.vlanId)).toEqual([10, 10])
    const client = store.wirelessClients.get('9c:aa:5d:9a:fc:8f')!
    expect(client).toMatchObject({
      apId: 'ap-foh',
      apName: 'AP Manu FOH',
      ssid: 'ABOUTUS-MGMT',
      band: '5 GHz',
      signal: -48,
      rateMbps: 2401,
      connectedSeconds: 939,
      vlanId: null,
      hostname: 'OPPO-Find-X9',
      ip: '192.168.99.159',
    })
  })

  it('only refreshes device and radio details every N polls', async () => {
    const ap = fakeAp()
    const poller = new EapPoller(ap.http)
    const store = sink()
    for (let index = 0; index < 3; index += 1) await poller.poll(target, { ...options, detailEvery: 3 }, store)
    const detailCalls = ap.calls.filter((call) => call.includes('status.device') || call.includes('status.wireless.radio') || call.includes('status.traffic.radio'))
    const clientCalls = ap.calls.filter((call) => call.includes('status.client.user'))
    expect(clientCalls).toHaveLength(3)
    expect(detailCalls).toHaveLength(1 + 2 * 2)
    // Radio info survives the cheap polls; throughput appears once a second detail sample exists.
    expect(store.accessPoints.get('ap-foh')!.radios).toHaveLength(2)
    expect(store.accessPoints.get('ap-foh')!.radios[1]!.txBps).toBeNull()
    await new Promise((resolve) => setTimeout(resolve, 20))
    await poller.poll(target, { ...options, detailEvery: 3 }, store)
    expect(store.accessPoints.get('ap-foh')!.radios[1]!.txBps).toBe(0)
  })

  it('backs off for a long time after a rejected login so it can never lock the AP', async () => {
    const ap = fakeAp()
    const poller = new EapPoller(ap.http)
    const store = sink()
    const bad = {
      ...options,
      credentials: { username: 'admin', password: 'wrong' },
    }
    await expect(poller.poll(target, bad, store)).rejects.toBeInstanceOf(EapAuthError)
    expect(store.accessPoints.get('ap-foh')?.lastError).toMatch(/login rejected/)
    const before = ap.logins()
    expect(await poller.poll(target, bad, store)).toBe(false)
    expect(ap.logins()).toBe(before)
    // Saving new settings resets the back-off.
    poller.reset()
    expect(await poller.poll(target, options, store)).toBe(true)
  })

  it('moves a client to the AP that reported it last (roaming)', async () => {
    const foh = fakeAp()
    const stage = fakeAp({
      password: 'secret',
      clients: [
        {
          key: 0,
          hostname: 'OPPO-Find-X9',
          Radio: 1,
          MAC: '9C-AA-5D-9A-FC-8F',
          IP: '192.168.99.159',
          SSID: 'ABOUTUS-MGMT',
          RSSI: -60,
          Rate: '1201.0',
          ActiveTime: '0 days 00:00:05',
          limit: 0,
          Down: 1,
          Up: 1,
        },
      ],
    })
    const http: HttpClient = {
      request: (url, init) => (url.includes('192.168.99.31') ? stage.http.request(url, init) : foh.http.request(url, init)),
    }
    const poller = new EapPoller(http)
    const store = sink()
    await poller.poll(target, options, store)
    await poller.poll({ id: 'ap-stage', name: 'AP Stage A', host: '192.168.99.31' }, options, store)
    expect(store.wirelessClients.get('9c:aa:5d:9a:fc:8f')?.apId).toBe('ap-stage')
    // The stage AP no longer lists it → its entry is dropped by that AP's next poll (the FOH AP still has it).
    stage.http = fakeAp({ password: 'secret', clients: [] }).http
    await poller.poll({ id: 'ap-stage', name: 'AP Stage A', host: '192.168.99.31' }, options, store)
    expect(store.wirelessClients.has('9c:aa:5d:9a:fc:8f')).toBe(false)
  })
})
