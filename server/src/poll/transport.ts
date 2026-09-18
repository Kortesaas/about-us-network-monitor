import type { HttpClient } from './eap.js'
/**
 * Every way the backend touches the network goes through these interfaces so
 * the demo mode can swap in a simulated network and tests can stay offline.
 */

export type PingResult = { ip: string; alive: boolean; rttMs: number | null }

export interface PingTransport {
  /** Pings many hosts with bounded concurrency; never throws for unreachable hosts. */
  ping(ips: string[], options?: { timeoutMs?: number; concurrency?: number }): Promise<PingResult[]>
  readonly tool: 'fping' | 'ping' | 'demo' | 'none'
}

export type NeighborEntry = {
  ip: string
  mac: string
  interface: string
  /** Linux neighbour states: REACHABLE means the host answered recently. */
  state: 'reachable' | 'stale' | 'other'
}

export interface NeighborSource {
  read(): Promise<NeighborEntry[]>
  readonly available: boolean
}

export type SnmpVarbind = { oid: string; value: SnmpValue }
export type SnmpValue = string | number | bigint | Buffer | null

export interface SnmpSession {
  get(oids: string[]): Promise<SnmpVarbind[]>
  /** Walks an entire subtree with GETBULK; resolves to [] for unsupported OIDs. */
  walk(oid: string): Promise<SnmpVarbind[]>
  close(): void
}

export type SnmpSessionOptions = {
  host: string
  community: string
  version: '1' | '2c'
  port: number
  timeoutMs: number
  retries: number
}

export interface SnmpTransport {
  open(options: SnmpSessionOptions): SnmpSession
  readonly available: boolean
}

export interface DnsResolver {
  reverse(ip: string): Promise<string | null>
  /** Forward lookup through the system resolver; used to prove DNS works end to end. */
  resolve(host: string): Promise<string[]>
  /** Nameservers the system uses, for display. */
  servers(): string[]
}

export type Transports = {
  ping: PingTransport
  neighbors: NeighborSource
  snmp: SnmpTransport
  dns: DnsResolver
  /** HTTP(S) client for devices with a web API (standalone Omada EAPs). */
  http: HttpClient
  /** Local interfaces with IPv4 addresses (name, ip, cidr). */
  interfaces(): { name: string; ip: string; cidr: string }[]
}
