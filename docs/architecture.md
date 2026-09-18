# Architecture

```
 browsers (phone / tablet / laptop)
   │  GET /api/state  +  SSE /api/events  (notify → refetch)
   ▼
 ┌────────────────────────── Raspberry Pi: server/ ──────────────────────────┐
 │  http/app.ts        Express API + static UI + SSE fan-out (http/sse.ts)     │
 │  state/store.ts     single source of truth: raw observations, known-device │
 │                     metadata, tracks, events; publish() → MonitorState     │
 │  analysis/*         raw → UI state: switches, devices, infra, vlans,       │
 │                     topology, wlan, checks (problems), summary             │
 │  poll/scheduler.ts  one job list; no overlap, pool limits, min gap         │
 │  poll/jobs.ts       builds jobs from settings + inventory                  │
 │  poll/snmp/*        net-snmp client, OIDs, vendor port mapping, pollers    │
 │  poll/ping.ts       fping (or system ping) sweeps and infra pings          │
 │  poll/neighbors.ts  ip neigh / arp -an                                     │
 │  poll/dns.ts        reverse DNS      poll/omada.ts   optional controller   │
 │  poll/eap.ts        standalone Omada EAP web API: radios, SSIDs, clients   │
 │  poll/syslog.ts     optional UDP receiver → events                         │
 │  poll/demo.ts       simulated network behind the same interfaces          │
 └────────────────────────────────────────────────────────────────────────────┘
```

## Data flow

1. **Inventory** (`config/inventory.json`, or `data/inventory.json` when uploaded
   through the UI) is parsed into planned VLANs, subnets and devices with their
   port plans and layouts. It is the *expectation*, never treated as live truth.
2. **Pollers** write raw observations into the `Store`: pings per IP, ARP rows
   (`ip|mac`, with source and freshness), per-switch SNMP snapshots (interfaces,
   counters, VLAN tables, PVIDs, FDB, LLDP), router sysinfo, DNS cache, and per
   access point its radios, SSIDs and associated clients (standalone EAP web
   API or Omada controller — both write the same `accessPoints` /
   `wirelessClients` maps, tagged by source).
3. After every job the scheduler asks the store to **publish**. `analysis/derive.ts`
   rebuilds the complete `MonitorState` (see `shared/types.ts`), the store diffs it
   against the previous one to produce **events**, and the SSE channel tells every
   browser that a new version exists. Browsers fetch `/api/state`.
4. **Persistence** (`data/state.json`, written atomically once a minute and on
   changes): known-device metadata, first-seen/location history per device,
   when each problem started, which ports ever had link, and the event ring.
   Settings live in `data/settings.json`.

## Device identity

* Identity is **MAC-first**. Every unicast MAC seen in ARP, the neighbour table, a
  switch FDB or the Omada client list is a device candidate. User metadata can
  merge several MACs (aliases) and the metadata id stays stable (`mac:…`, `ip:…`
  or the known-device id).
* An IP that answers pings but never shows a MAC becomes an **IP-only** device.
* **MAC-only** observations (in a FDB, no IP) are kept for correlation but hidden
  from the device list by default.
* Planned infrastructure attaches by management IP; the router's gateway
  addresses fold into the router. Infrastructure whose IP lies outside every
  planned subnet is listed as *not monitored* instead of *offline*.
* **Confirmation of life** = a ping answer, a `REACHABLE` neighbour entry, presence
  in a switch FDB (the switch saw a frame within its aging time) or an active
  wireless client. A router ARP row alone is *not* confirmation.
* **Location** = newest FDB sighting on a non-uplink port. Infrastructure is
  located through LLDP first. Sightings on uplink ports are only hints
  (`flags`). A port is an uplink when LLDP shows a switch/router there, when it
  has learned more MACs than `uplinkMacThreshold`, or when it is a planned
  non-AP trunk carrying several MACs — so the Pi on its own trunk port is still
  an edge device.
* Status: `located` / `unlocated` / `relocating` (moved within the relocation
  window) while confirmed within `staleAfterSeconds`; then `stale`, then `offline`.

## Setup: which planned devices are in use

`store.infraUse` (persisted) records for each planned device whether it is part
of the current setup, and whether that was decided automatically (first
successful ping) or manually. Rules:

* not in use → pinged (cheaply, so it can join), never SNMP-polled, never a
  problem, no placeholder device entry, dimmed in the topology;
* auto-enable only ever turns a device **on**; only the user turns one off;
* a manual choice is never overridden by auto;
* trunk/AP ports only count as "lost link" when they had link in this setup
  (`portsSeenUp`);
* **Start new setup** (`POST /api/setup/reset`) forgets auto-added devices,
  seen-up ports and problem start times; manual choices and device metadata stay.

## Planned vs discovered ports

For every switch port the VLAN membership is read from Q-BRIDGE-MIB (static
tables, falling back to the current tables): untagged set, tagged set and PVID.
`diffPort()` in `analysis/switches.ts` compares that with the plan and reports
only operationally relevant differences (mode, access VLAN, native VLAN, missing
tagged, extra tagged). A trunk whose native VLAN equals a planned tagged VLAN is
not flagged as missing that VLAN.

Vendor naming (`poll/snmp/vendor.ts`): Dell `Gi1/0/N` / `Te1/0/N`, TP-Link
`gigabitEthernet 1/0/N`, Allied `Port N`, generic trailing number; validated
against the planned port count, otherwise Ethernet interfaces are numbered in
ifIndex order. The chosen rule is shown in the switch inspector so it can be
checked on site (`npm run snmp:probe` prints the raw names).

## Frontend

React + Vite + Tailwind with the same design tokens as the planner
(`web/src/styles.css`). `stores/monitorStore.ts` holds the one SSE connection
and the last state; pages are pure renderers over `MonitorState`.
`components/SwitchFace.tsx` renders port maps using `shared/portLayout.ts` — the
same pairing algorithm as the planner's labels.
