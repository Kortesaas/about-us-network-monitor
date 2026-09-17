/**
 * The API contract between the Pi backend and the browser UI.
 *
 * Everything the UI renders comes from `MonitorState`, which the backend
 * publishes over `GET /api/state` and announces over `GET /api/events`.
 * Browsers never scan anything themselves.
 */

/* ------------------------------------------------------------ inventory */

export type PlannedVlan = {
  vlanId: number
  name: string
  color: string
  description: string
  purpose: string
}

export type PlannedSubnet = {
  vlanId: number | null
  name: string
  cidr: string
  gateway: string
  dhcpStart: string
  dhcpEnd: string
  dns: string[]
}

export type DeviceKind =
  | 'switch'
  | 'router'
  | 'access-point'
  | 'server'
  | 'computer'
  | 'media'
  | 'custom'

export type PortLayout = 'sequential' | 'odd-even' | 'bottom-up'
export type PortRole = 'lan' | 'wan' | 'sfp'
export type PortMode = 'access' | 'trunk' | 'hybrid' | 'unused'

export type PlannedPort = {
  number: number
  role: PortRole
  name: string
  mode: PortMode
  accessVlanId: number | null
  nativeVlanId: number | null
  taggedVlanIds: number[]
  poe: boolean
  speed: string
}

/** A device from the planning JSON: what *should* be on the network. */
export type PlannedDevice = {
  id: string
  type: DeviceKind
  name: string
  manufacturer: string
  model: string
  location: string
  rack: string
  managementIp: string
  managementVlanId: number | null
  portCount: number
  sfpPortCount: number
  wanPortCount: number
  layout: PortLayout
  ports: PlannedPort[]
  /** Planned canvas position from the reference app, used as a topology hint. */
  position: { x: number; y: number }
}

/* --------------------------------------------------------- live status */

/**
 * `online`   answered a ping / confirmed on the local neighbour table recently
 * `stale`    last confirmation is older than the stale window
 * `offline`  older than the offline window (or never confirmed)
 * `unknown`  the backend has no way to check it (no IP, sweeps disabled…)
 */
export type Reachability = 'online' | 'stale' | 'offline' | 'unknown'

export type SnmpHealth = {
  enabled: boolean
  ok: boolean
  lastOkAt: string | null
  lastError: string | null
  /** Milliseconds the last successful full poll took. */
  lastDurationMs: number | null
}

export type PortLink = {
  operUp: boolean
  adminUp: boolean
  /** Mbit/s as reported by ifHighSpeed, null when unknown. */
  speedMbps: number | null
  lastChangeAt: string | null
}

export type PortCounters = {
  inOctets: number
  outOctets: number
  inErrors: number
  outErrors: number
  inDiscards: number
  outDiscards: number
  sampledAt: string
}

export type PortRates = {
  inBps: number
  outBps: number
  /** Errors + discards per minute over the last interval. */
  errorsPerMin: number
  /** Last few samples (bits/s), newest last, for a tiny sparkline. */
  history: { t: string; inBps: number; outBps: number }[]
}

export type DiscoveredPortConfig = {
  pvid: number | null
  untaggedVlanIds: number[]
  taggedVlanIds: number[]
  mode: 'access' | 'trunk' | 'unknown'
}

export type LldpNeighbor = {
  chassisId: string
  portId: string
  portDescription: string
  sysName: string
  sysDescription: string
  managementIp: string | null
  /** Inventory id when the neighbour could be matched to a planned device. */
  deviceId: string | null
}

export type PortDiff =
  | { kind: 'mode'; planned: string; discovered: string }
  | { kind: 'access-vlan'; planned: number | null; discovered: number | null }
  | { kind: 'native-vlan'; planned: number | null; discovered: number | null }
  | { kind: 'missing-tagged'; vlanIds: number[] }
  | { kind: 'extra-tagged'; vlanIds: number[] }

export type SwitchPort = {
  number: number
  ifIndex: number | null
  ifName: string | null
  ifAlias: string | null
  role: PortRole
  planned: PlannedPort | null
  link: PortLink | null
  counters: PortCounters | null
  rates: PortRates | null
  discovered: DiscoveredPortConfig | null
  diffs: PortDiff[]
  lldp: LldpNeighbor[]
  /** True when the port faces another switch/router — MACs seen here are not "located" here. */
  uplink: boolean
  /** MACs learned on this port from the FDB, newest first. */
  macs: { mac: string; vlanId: number | null; deviceId: string | null; lastSeenAt: string }[]
  /** Devices located on this port (the reason the port is interesting). */
  devices: { id: string; name: string; ip: string | null; vlanId: number | null }[]
}

export type SwitchState = {
  id: string
  name: string
  manufacturer: string
  model: string
  managementIp: string
  location: string
  layout: PortLayout
  portCount: number
  sfpPortCount: number
  reachability: Reachability
  rttMs: number | null
  snmp: SnmpHealth
  sysName: string | null
  sysDescr: string | null
  sysLocation: string | null
  /** Uptime in seconds derived from sysUpTime. */
  uptimeSeconds: number | null
  /** VLANs the switch actually has configured. */
  vlans: { vlanId: number; name: string | null }[]
  ports: SwitchPort[]
  lastPolledAt: string | null
  /** ifName → port number mapping notes so the user can verify the layout. */
  portMappingNote: string | null
}

/* ------------------------------------------------------- infra devices */

export type InfraState = {
  id: string
  type: DeviceKind
  name: string
  manufacturer: string
  model: string
  managementIp: string
  location: string
  /** False when the management IP lies outside every planned subnet — the Pi cannot reach it, so it is listed but not checked. */
  monitored: boolean
  /**
   * Whether this device is part of the current setup. Planned devices start out unused (no SNMP, no
   * problems); they switch to in-use automatically the first time they answer, or manually. Never
   * switched off automatically — an outage must stay visible.
   */
  inUse: boolean
  inUseSource: 'auto' | 'manual' | null
  inUseSince: string | null
  reachability: Reachability
  rttMs: number | null
  lastSeenAt: string | null
  snmp: SnmpHealth | null
  sysName: string | null
  sysDescr: string | null
  uptimeSeconds: number | null
  /** Where the infra device itself shows up (e.g. an AP on a switch port). */
  locatedAt: { switchId: string; switchName: string; port: number } | null
  mac: string | null
  /** Access points: client/radio info when an AP data source is configured. */
  wireless: {
    clients: number
    ssids: string[]
    radios: { band: string; channel: number | null; clients: number }[]
  } | null
}

/* -------------------------------------------------------- end devices */

/**
 * `located`     online, and its switch port is known
 * `unlocated`   online, but no switch port could be attributed
 * `relocating`  online, and it moved ports/switches within the relocation window
 * `stale`       not confirmed within the stale window
 * `offline`     not confirmed within the offline window
 */
export type DeviceStatus = 'located' | 'unlocated' | 'relocating' | 'stale' | 'offline'

export type DeviceLocation = {
  switchId: string
  switchName: string
  port: number
  portName: string | null
  vlanId: number | null
  since: string
  lastSeenAt: string
}

export type KnownDeviceMeta = {
  id: string
  displayName: string
  owner: string
  category: string
  notes: string
  favorite: boolean
  ignored: boolean
  /** Normalised MACs (lower-case, colon separated) that all belong to this device. */
  macs: string[]
  /** Optional fixed IP for devices whose MAC cannot be learned (behind a router). */
  ips: string[]
  createdAt: string
  updatedAt: string
}

export type DeviceState = {
  /** Stable id: `mac:<mac>` for MAC-identified devices, `ip:<ip>` for IP-only ones, or the known-device id. */
  id: string
  status: DeviceStatus
  online: boolean
  /** Name shown in lists: user display name, else hostname, else vendor, else MAC/IP. */
  name: string
  hostname: string | null
  vendor: string | null
  macs: string[]
  primaryMac: string | null
  ips: string[]
  primaryIp: string | null
  /** VLAN derived from the IP subnet (planned) or from the FDB. */
  vlanId: number | null
  vlanSource: 'subnet' | 'fdb' | null
  location: DeviceLocation | null
  previousLocation: DeviceLocation | null
  /** Inventory id when this is a planned infra device. */
  infraId: string | null
  known: KnownDeviceMeta | null
  firstSeenAt: string
  lastSeenAt: string
  /** Last time we had positive confirmation it is alive (ping / reachable ARP). */
  lastConfirmedAt: string | null
  rttMs: number | null
  /** Where we learned about it. */
  sources: ('ping' | 'arp' | 'neighbor' | 'fdb' | 'lldp' | 'dns' | 'omada' | 'inventory')[]
  /** MAC-only observations are correlation data, never "healthy devices". */
  macOnly: boolean
  wireless: { ap: string | null; ssid: string | null; band: string | null; signal: number | null } | null
  flags: string[]
}

/* ---------------------------------------------------------- internet */

export type InternetTarget = {
  /** IP or hostname that is pinged. */
  target: string
  label: string
  reachability: Reachability
  rttMs: number | null
  lastSeenAt: string | null
}

export type InternetState = {
  enabled: boolean
  /** Up when at least one target answers. */
  status: Reachability
  targets: InternetTarget[]
  dns: {
    host: string
    ok: boolean | null
    resolvedTo: string | null
    error: string | null
    checkedAt: string | null
    /** Which resolver the Pi used (from /etc/resolv.conf when readable). */
    resolvers: string[]
  }
  checkedAt: string | null
}

/* ------------------------------------------------------------- vlans */

export type VlanState = {
  vlanId: number
  name: string
  color: string
  description: string
  planned: boolean
  subnet: PlannedSubnet | null
  gatewayReachability: Reachability | null
  gatewayRttMs: number | null
  deviceCount: number
  onlineDeviceCount: number
  /** Which switches actually have this VLAN configured. */
  presentOn: { switchId: string; switchName: string; present: boolean }[]
  /** Ports carrying the VLAN (access/untagged or tagged). */
  ports: { switchId: string; switchName: string; port: number; tagged: boolean; up: boolean }[]
}

/* ---------------------------------------------------------- topology */

export type TopologyNode = {
  id: string
  kind: DeviceKind | 'unknown'
  name: string
  subtitle: string
  ip: string | null
  reachability: Reachability
  /** Planned or discovered-only. */
  planned: boolean
  /** Planned infrastructure that is not part of the current setup is drawn dimmed. */
  inUse: boolean
  hint: { x: number; y: number } | null
  /** Trunk ports that should have a neighbour but have none. */
  danglingTrunks: { port: number; name: string; up: boolean }[]
}

export type TopologyEdge = {
  id: string
  source: string
  sourcePort: number | null
  sourcePortName: string | null
  target: string
  targetPort: number | null
  targetPortName: string | null
  /** lldp = seen live, planned = expected from the inventory, client = a located device. */
  origin: 'lldp' | 'planned' | 'client'
  up: boolean
  speedMbps: number | null
  vlanIds: number[]
  warnings: string[]
}

/* ---------------------------------------------------------- problems */

export type ProblemSeverity = 'critical' | 'warning' | 'info'

export type Problem = {
  id: string
  code: string
  severity: ProblemSeverity
  title: string
  detail: string
  suggestion: string
  subject: {
    type: 'infra' | 'switch' | 'port' | 'device' | 'vlan' | 'system'
    id: string
    label: string
    /** Route the UI can jump to. */
    href: string
  }
  since: string
  lastSeenAt: string
}

/* ------------------------------------------------------------ events */

export type EventKind =
  | 'device-online'
  | 'device-offline'
  | 'device-new'
  | 'device-moved'
  | 'port-up'
  | 'port-down'
  | 'infra-online'
  | 'infra-offline'
  | 'problem-raised'
  | 'problem-cleared'
  | 'scan'
  | 'syslog'
  | 'system'

export type MonitorEvent = {
  id: string
  at: string
  kind: EventKind
  severity: ProblemSeverity | 'ok'
  message: string
  subject: { type: string; id: string; label: string; href: string } | null
}

/* ------------------------------------------------------------- scans */

export type JobStatus = {
  id: string
  label: string
  /** Seconds between runs; 0 for manual-only jobs. */
  intervalSeconds: number
  running: boolean
  queued: boolean
  lastStartedAt: string | null
  lastFinishedAt: string | null
  lastDurationMs: number | null
  lastError: string | null
  nextDueAt: string | null
  runs: number
  failures: number
}

export type ScanStatus = {
  jobs: JobStatus[]
  /** Any job running right now. */
  busy: boolean
  /** Human readable summary such as "Polling Dell FOH Manu…". */
  activity: string | null
  /** When a manual refresh was last requested. */
  lastRequestedAt: string | null
}

/* ----------------------------------------------------------- settings */

export type SnmpTarget = {
  deviceId: string
  community: string
  version: '1' | '2c'
  port: number
  enabled: boolean
}

export type Settings = {
  polling: {
    /** Ping of all planned infrastructure + favourites. */
    infraPingSeconds: number
    /** Interface status & counters. */
    snmpFastSeconds: number
    /** FDB / LLDP tables. */
    snmpTablesSeconds: number
    /** VLAN configuration & system info. */
    snmpConfigSeconds: number
    /** Router ARP table. */
    routerArpSeconds: number
    /** Local neighbour table (ip neigh). */
    neighborSeconds: number
    /** Per-subnet ping sweep. */
    sweepSeconds: number
    /** How many SNMP devices are polled at once. */
    snmpConcurrency: number
    /** Minimum gap between two runs of the same job, even on manual refresh. */
    minGapSeconds: number
    /** Reverse DNS lookups. */
    dnsSeconds: number
  }
  thresholds: {
    staleAfterSeconds: number
    offlineAfterSeconds: number
    relocationWindowSeconds: number
    /** A port with more distinct MACs than this is treated as an uplink. */
    uplinkMacThreshold: number
    /** Errors/discards per minute before a port is flagged. */
    portErrorsPerMinute: number
    /** Events kept in the ring buffer. */
    eventHistory: number
  }
  discovery: {
    /** Subnet CIDRs that are swept; empty = all planned subnets. */
    sweepCidrs: string[]
    sweepEnabled: boolean
    /** Do not sweep these CIDRs even when they are planned (WAN etc.). */
    excludeCidrs: string[]
    reverseDns: boolean
    routerArp: boolean
    localNeighbors: boolean
  }
  snmp: {
    timeoutMs: number
    retries: number
    targets: SnmpTarget[]
    /** Community used for planned devices without an explicit target, by manufacturer. */
    defaultCommunities: Record<string, string>
  }
  omada: {
    enabled: boolean
    baseUrl: string
    omadacId: string
    siteId: string
    clientId: string
    clientSecret: string
    insecureTls: boolean
    intervalSeconds: number
  }
  syslog: {
    enabled: boolean
    port: number
  }
  internet: {
    enabled: boolean
    /** Pinged in parallel; WAN counts as up when any answers. */
    targets: string[]
    /** Hostname resolved through the Pi's configured DNS to prove DNS works end to end. */
    dnsCheckHost: string
    intervalSeconds: number
  }
  ui: {
    /** Show MAC-only observations in the device list by default. */
    showMacOnly: boolean
  }
}

/** Settings as returned by the API: secrets are masked. */
export type PublicSettings = Settings

/* -------------------------------------------------------------- state */

export type BackendInfo = {
  version: string
  mode: 'live' | 'demo'
  hostname: string
  startedAt: string
  platform: string
  /** Capabilities detected at start-up. */
  capabilities: {
    fping: boolean
    ping: boolean
    ipNeigh: boolean
    arp: boolean
    snmp: boolean
  }
  /** Local interfaces & the planned subnets they can reach directly. */
  interfaces: { name: string; ip: string; cidr: string; vlanId: number | null }[]
  /** Warnings about the environment (missing fping, no VLAN interfaces…). */
  notices: string[]
}

export type Summary = {
  /** Infrastructure counts only include devices that are in use. */
  infraTotal: number
  infraOnline: number
  infraUnused: number
  switchesTotal: number
  switchesSnmpOk: number
  devicesOnline: number
  devicesLocated: number
  devicesUnlocated: number
  devicesStale: number
  devicesUnknown: number
  devicesFavoriteOffline: number
  vlansPlanned: number
  vlansDiscovered: number
  portsUp: number
  portsTotal: number
  problemsCritical: number
  problemsWarning: number
  problemsInfo: number
  /** Overall health traffic light. */
  health: 'ok' | 'degraded' | 'critical' | 'unknown'
}

export type MonitorState = {
  /** Increments on every publish; the SSE channel announces new versions. */
  version: number
  generatedAt: string
  backend: BackendInfo
  summary: Summary
  scan: ScanStatus
  internet: InternetState
  vlans: VlanState[]
  infra: InfraState[]
  switches: SwitchState[]
  devices: DeviceState[]
  topology: { nodes: TopologyNode[]; edges: TopologyEdge[] }
  problems: Problem[]
  events: MonitorEvent[]
  plannedDevices: PlannedDevice[]
  subnets: PlannedSubnet[]
}

/* --------------------------------------------------------- SSE frames */

export type LiveMessage =
  | { type: 'hello'; version: number; backend: BackendInfo }
  | { type: 'state'; version: number; changed: (keyof MonitorState)[] }
  | { type: 'scan'; scan: ScanStatus }
  | { type: 'event'; event: MonitorEvent }
  | { type: 'ping' }

export type ScanScope = 'all' | 'infra' | 'switches' | 'sweep' | 'neighbors' | `switch:${string}`
