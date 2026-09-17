# Polling & discovery strategy

Goal: always-fresh state without ever loading a show network. Everything is
paced by one scheduler (`server/src/poll/scheduler.ts`):

* a job never overlaps itself;
* SNMP jobs share a pool (default **3** devices at once);
* sweeps run one subnet at a time;
* every job has a minimum gap (default **5 s**) that also applies to manual
  "Refresh" — a stuck finger cannot flood anything;
* failures are recorded and shown, never retried in a tight loop.

## Default cadence

| Job | Every | Cost | Why |
| --- | --- | --- | --- |
| Ping infrastructure (router, switches, APs, gateways, favourites) | 15 s | ~15 packets | Outages must show within seconds. |
| Local neighbour table (`ip neigh`) | 20 s | none (kernel table) | Fresh IP↔MAC for on-link subnets. |
| Switch: port status & counters (IF-MIB) | 30 s | ~10 column walks per switch | Link up/down, speeds, traffic rates, error deltas. |
| Switch: MAC & LLDP tables (Q-BRIDGE, LLDP-MIB) | 120 s | FDB walk (~1 row per MAC) + LLDP | Where devices are plugged in; topology. |
| Switch: VLAN configuration & sysinfo | 300 s | VLAN tables + PVIDs | Rarely changes; keeps plan comparison current. |
| Internet & DNS check (ping 1.1.1.1 / 8.8.8.8, resolve a hostname) | 30 s | 2 packets + 1 query | WAN status and whether DNS works end to end. |
| Router ARP table (SNMP `ipNetToMedia`) | 60 s | one walk | IP↔MAC for every VLAN, even those the Pi is not in. |
| Subnet sweep (`fping -i 10`) | 180 s per subnet | 254 packets spaced 10 ms | Finds hosts that never talk to the Pi; only one subnet at a time. |
| Reverse DNS | 30 s (cache 600 s) | a few queries | Hostnames from the router's DNS. |
| Omada controller (optional) | 60 s | 2 HTTPS calls | Wi-Fi clients per AP/SSID/radio. |
| Save state | 60 s | disk | Metadata/events survive restarts. |

Everything is configurable in **Settings → Polling**; changes are applied live.

Rough load on the network with five switches: under **2 packets/s** of SNMP and
one /24 sweep every three minutes — negligible even for Dante VLANs.

## Reachability semantics

* Infrastructure: `online` while the last ping answered; `stale` for one or two
  missed pings (up to 90 s); `offline` after that. SNMP is skipped for a device
  that just failed a ping so timeouts do not pile up.
* Devices: see [architecture.md](architecture.md#device-identity). Defaults:
  stale after 5 min, offline after 15 min, relocation window 10 min.
* A problem is only raised for SNMP after a poll actually failed — "no data yet"
  right after start-up is not a problem.

## Safety

* Read-only: SNMP GET/GETBULK only, ICMP echo only. The monitor never writes to
  a device.
* Sweeps refuse ranges larger than /22 and skip anything in **Never sweep**.
* WAN/passthrough VLANs (no planned subnet) are not expected on every switch
  and are excluded from "missing VLAN" checks.
* Devices whose management IP lies outside every planned subnet (e.g. a
  WAN-side router) are listed as *not monitored* and never pinged.

## What needs what

| Feature | Needs |
| --- | --- |
| Port maps, link state, counters | SNMP v2c read community on the switch (IF-MIB) |
| Live vs planned VLANs | Q-BRIDGE-MIB (`dot1qVlanStatic*`, `dot1qPvid`) — supported by Dell N-series, TP-Link JetStream, Allied GS950 |
| Device location | `dot1qTpFdbPort` (or `dot1dTpFdbPort`) |
| Topology | LLDP enabled on the switches (and `lldpd` on the Pi so the Pi shows up too) |
| IP↔MAC in every VLAN | Router ARP over SNMP (LANCOM community) **or** Pi VLAN sub-interfaces |
| Wi-Fi client details | Omada controller with an Open API client (standalone EAPs have none) |
