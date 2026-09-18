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
| Router WAN throughput (IF-MIB HC counters) | 15 s | one GET of ~10 OIDs (interface list re-walked every 5 min) | Real internet download/upload; also the router's physical ports. |
| Subnet sweep (`fping -i 10`) | 180 s per subnet | 254 packets spaced 10 ms | Finds hosts that never talk to the Pi; only one subnet at a time. |
| Reverse DNS | 30 s (cache 600 s) | a few queries | Hostnames from the router's DNS. |
| Access point: Wi-Fi clients & SSIDs (standalone EAP web API) | 10 s per AP | 2 small HTTPS calls on a kept-alive session (~200 ms) | Who is on which AP/SSID with what signal; roaming shows within one interval. |
| Access point: device, radio settings, radio counters | every 6th client poll (60 s) | 1 + 2 calls per radio | Channel, width, power, uptime, load, per-band throughput. |
| Omada controller (optional) | 60 s | 2 HTTPS calls | Same data from a controller for adopted APs. |
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
| Wi-Fi client details | The standalone EAPs' admin login (Settings → Integrations → Access points) **or** an Omada controller with an Open API client |

## Standalone access points

Omada EAPs in standalone mode have no useful SNMP (MIB-II only) and no
controller API, but their web UI is a plain JSON API, so `poll/eap.ts` logs in
exactly like the browser does (`POST /` with `MD5(password)`) and reads the
same `/data/*.json` endpoints the Status pages use. Things to know:

* **One admin session per AP.** A new login — ours or a browser's — ends the
  previous one. The poller keeps its cookie and only logs in again when the AP
  answers `timeout: true`, so opening an AP's web UI costs one re-login on the
  next poll, nothing more.
* **Rejected logins count.** The AP locks the admin account after ~30 failed
  attempts. After a rejected login the poller waits 10 minutes before trying
  again; saving the settings resets that immediately. The Problems page shows
  the reason (wrong password, locked, not a standalone EAP).
* **Cheap by design.** Client and SSID lists are two ~2 KB requests per AP on
  a kept-alive TLS connection; device info, radio settings and counters are
  read every sixth poll. Two APs at the default 10 s interval are well under
  one request per second. Other failures back off from 30 s up to 5 min.
* **Only APs in the setup** are polled (same rule as SNMP), and only planned
  access points with a management IP in a monitored subnet.
* Verified on EAP650 v3 firmware 1.5.6; other Omada EAPs with the same
  standalone UI should behave identically. Non-Omada APs (e.g. a TL-WA1201)
  cannot be read.

## Throughput

Everything is derived from 64-bit octet counters (IF-MIB `ifHCIn/OutOctets`),
sampled at the intervals above; a rate is the delta between two samples, and a
counter wrap or reset yields no sample rather than a spike.

| Series | Source | Meaning |
| --- | --- | --- |
| Internet | The router's WAN interface(s): names matching `DSL-*`, `VDSL`, `WAN-*`, `PPPOE-*`, `LTE-*` (LANCOM's logical WAN link, not the `-CH-` channels or the physical modem), or the names set in Settings → Discovery | Actual internet download / upload |
| Router link | Switch ports whose LLDP neighbour is the router | Everything routed: internet plus traffic between VLANs |
| VLAN *n* | Sum over access ports (live PVID, else the plan) in that VLAN on switches in the setup; uplinks and trunks are never attributed | What the devices in the VLAN send and receive at their own ports. Multicast that reaches many ports (Dante, sACN) is counted once per receiving port. |

Not measurable with SNMP alone and therefore not shown: how much of the
internet traffic belongs to which VLAN or device (needs flow accounting on the
router), and traffic on switches without SNMP.

History: 720 samples per series (3 h of WAN at 15 s, 6 h of switch data at
30 s), kept in `data/state.json` across restarts. `/api/state` carries the last
60 samples; `/api/traffic` the whole ring.

