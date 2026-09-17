/**
 * Raw observations exactly as the pollers produced them. The analysis layer
 * turns these into the `MonitorState` the UI shows; nothing here is rendered
 * directly.
 */

export type RawInterface = {
  ifIndex: number
  ifName: string | null
  ifDescr: string | null
  ifAlias: string | null
  ifType: number | null
  physAddress: string | null
  adminUp: boolean | null
  operUp: boolean | null
  /** ifLastChange in hundredths of a second of sysUpTime. */
  lastChangeTicks: number | null
  speedMbps: number | null
  counters: {
    inOctets: bigint
    outOctets: bigint
    inErrors: number
    outErrors: number
    inDiscards: number
    outDiscards: number
    sampledAt: number
  } | null
}

export type RawFdbEntry = { mac: string; vlanId: number | null; bridgePort: number; seenAt: number }

export type RawLldpNeighbor = {
  localPortNum: number
  chassisIdSubtype: number | null
  chassisId: string
  portIdSubtype: number | null
  portId: string
  portDesc: string
  sysName: string
  sysDesc: string
  managementIp: string | null
}

export type RawVlan = {
  vlanId: number
  name: string | null
  egressBridgePorts: number[]
  untaggedBridgePorts: number[]
}

export type RawSwitch = {
  deviceId: string
  sys: {
    descr: string | null
    name: string | null
    location: string | null
    objectId: string | null
    upTimeTicks: number | null
    at: number
  } | null
  interfaces: Map<number, RawInterface>
  /** ifIndex → physical port number, worked out from ifName/ifDescr. */
  portMap: Map<number, number>
  portMapNote: string | null
  bridgePortToIfIndex: Map<number, number>
  vlans: RawVlan[]
  pvid: Map<number, number>
  fdb: RawFdbEntry[]
  lldpLocalPorts: Map<number, { portId: string; portDesc: string }>
  lldp: RawLldpNeighbor[]
  lastFastAt: number | null
  lastTablesAt: number | null
  lastConfigAt: number | null
  lastOkAt: number | null
  /** Last time an SNMP request was actually sent (successful or not). */
  lastAttemptAt: number | null
  lastError: string | null
  lastDurationMs: number | null
  /** Rate samples per port number, newest last. */
  rateHistory: Map<number, { t: number; inBps: number; outBps: number; errorsPerMin: number }[]>
}

export const emptyRawSwitch = (deviceId: string): RawSwitch => ({
  deviceId,
  sys: null,
  interfaces: new Map(),
  portMap: new Map(),
  portMapNote: null,
  bridgePortToIfIndex: new Map(),
  vlans: [],
  pvid: new Map(),
  fdb: [],
  lldpLocalPorts: new Map(),
  lldp: [],
  lastFastAt: null,
  lastTablesAt: null,
  lastConfigAt: null,
  lastOkAt: null,
  lastAttemptAt: null,
  lastError: null,
  lastDurationMs: null,
  rateHistory: new Map(),
})

export type RawPing = { ip: string; alive: boolean; rttMs: number | null; at: number; lastAliveAt: number | null }

export type RawArp = {
  ip: string
  mac: string
  source: 'router' | 'local'
  /** Only the local neighbour table tells us whether the entry is fresh. */
  reachable: boolean
  at: number
}

export type RawSysInfo = {
  descr: string | null
  name: string | null
  upTimeTicks: number | null
  at: number
  lastError: string | null
  lastOkAt: number | null
  lastDurationMs: number | null
}

export type RawWirelessClient = {
  mac: string
  ip: string | null
  hostname: string | null
  apName: string | null
  apMac: string | null
  ssid: string | null
  band: string | null
  signal: number | null
  at: number
}

export type RawAccessPoint = {
  mac: string
  ip: string | null
  name: string
  status: 'online' | 'offline' | 'unknown'
  clients: number
  ssids: string[]
  radios: { band: string; channel: number | null; clients: number }[]
  at: number
}
