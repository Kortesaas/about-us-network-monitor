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

export type RawRouterInterface = {
  ifIndex: number
  name: string
  operUp: boolean
  wan: boolean
  inOctets: number | null
  outOctets: number | null
  inBps: number | null
  outBps: number | null
}

/** Interface counters of a router (IF-MIB HC counters), with rates derived from the previous sample. */
export type RawRouterTraffic = {
  deviceId: string
  interfaces: RawRouterInterface[]
  /** The router's own bridge MAC table: which of its LAN ports a MAC is behind (Q-BRIDGE, when exposed). */
  fdb: { mac: string; vlanId: number | null; ifIndex: number; portName: string }[]
  /** Bridge port → ifIndex and ifIndex → ifName, refreshed with the interface list. */
  bridgePorts: Map<number, number>
  names: Map<number, string>
  /** When the interface list was last discovered (names/status). */
  discoveredAt: number
  at: number
  lastOkAt: number | null
  lastError: string | null
}

export type RawWirelessClient = {
  mac: string
  source: 'eap' | 'omada'
  ip: string | null
  hostname: string | null
  /** Planned AP id (eap) or AP MAC (omada). */
  apId: string
  apName: string | null
  apMac: string | null
  ssid: string | null
  radioId: number | null
  band: string | null
  vlanId: number | null
  signal: number | null
  rateMbps: number | null
  connectedSeconds: number | null
  rxBytes: number | null
  txBytes: number | null
  rxBps: number | null
  txBps: number | null
  at: number
}

export type RawApRadio = {
  id: number
  band: string
  enabled: boolean
  channel: number | null
  frequencyMhz: number | null
  widthMhz: number | null
  mode: string | null
  txPowerDbm: number | null
  maxRateMbps: number | null
  clients: number
  rxBytes: number | null
  txBytes: number | null
  rxBps: number | null
  txBps: number | null
}

export type RawApSsid = {
  ssid: string
  radioId: number
  vlanId: number | null
  security: string | null
  guest: boolean
  portal: boolean
  clients: number
}

export type RawAccessPoint = {
  /** Planned AP id (eap) or AP MAC (omada). */
  id: string
  source: 'eap' | 'omada'
  mac: string | null
  ip: string | null
  name: string
  model: string | null
  firmware: string | null
  hardware: string | null
  status: 'online' | 'offline' | 'unknown'
  uptimeSeconds: number | null
  cpuPercent: number | null
  memoryPercent: number | null
  lanLink: string | null
  clients: number
  ssids: RawApSsid[]
  radios: RawApRadio[]
  /** Last poll attempt. */
  at: number
  lastOkAt: number | null
  /** When device info, radio settings and radio counters were last read (they are refreshed less often than clients). */
  detailsAt: number | null
  lastError: string | null
  lastDurationMs: number | null
}
