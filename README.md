# ABOUTUS Network Monitor

Live dashboard for the ABOUTUS event network, hosted on the Raspberry Pi
(`aboutus-net`, `192.168.99.2`) and reachable from any phone, tablet or laptop
on the network at **http://aboutus-net** or **http://192.168.99.2**.

It takes the planning export of the [Network Config](../about-us-network-config)
planner as the *plan*, discovers the *real* network over SNMP, LLDP, ARP and
ping, and shows where the two differ — so during a show you can see at a glance
what is online, where it is plugged in, which VLAN it is in, and whether the
trunks, APs and uplinks are healthy.

See [docs/screenshots.md](docs/screenshots.md) for what the demo scenario shows.

## What it shows

| Page | What you get |
| --- | --- |
| **Overview** | One screen: health, infrastructure in use, internet/WAN and DNS checks (1.1.1.1, 8.8.8.8, hostname resolution), problems, recent changes. |
| **Problems** | Production checks with severity, affected device/port, explanation and suggested fix (wrong access VLAN, missing VLAN on trunk, AP trunk mismatch, offline infrastructure, stale SNMP, duplicate IP, port errors, down uplinks, LLDP on access ports, device in wrong VLAN…). |
| **Devices** | Everything currently on the network: IP, MAC, hostname/vendor, VLAN, switch + port, status (located / unlocated / relocating / stale / offline). Filter by VLAN, switch, status, known/unknown. Name, owner, category, notes, favourite/ignore and MAC aliases follow the device across IP and port changes. |
| **Switches & Ports** | Physical port maps in the planner's colours and layouts (odd/even, bottom-up, SFP block). Per port: link, speed, live vs planned VLANs, learned MACs, located devices, LLDP neighbour, traffic and errors. Differences from the plan are marked. |
| **Topology** | Live graph from LLDP with planned infrastructure as the backbone, link speed and VLANs, expected-but-missing trunks, optional located clients. |
| **VLANs** | Planned and discovered VLANs, subnets, gateway reachability, members, and every port carrying the VLAN. |
| **Events** | Timeline of joins, leaves, moves, link changes, outages, problems raised/cleared (kept across restarts). |
| **Settings** | Setup (which planned devices are in use, new-show reset), polling cadence, thresholds, SNMP communities, discovery sources, inventory upload, Omada/syslog integrations, export/import. |

**Not every planned device is on every job.** A planned device joins the
*setup* automatically the first time it answers a ping and is never removed
automatically — so an outage stays visible. Devices not in use are pinged only
(never SNMP-polled) and never raise problems; toggle them in **Settings → Setup**
and press **Start new setup** before the next show to forget what was learned.

The **browser never scans anything**. The Pi backend owns polling, discovery,
cooldowns, concurrency, caching, timestamps and pushes updates over
Server-Sent Events. "Refresh" asks the backend to run its jobs now — it still
respects the minimum gap between runs, so it can never flood the network.

## Quick start (development, on any machine)

```bash
npm install
npm run dev:demo      # backend on :8080 with a simulated show network + Vite UI on :5174
```

Open http://localhost:5174. The demo network contains deliberate problems (an
offline switch, a wrong access VLAN, a flapping AP, a duplicate IP, a moving
laptop…) so every state of the UI can be seen without the rack.

`npm run dev` runs the backend against the real network from your machine
(uses `arp -a`/`ping` on macOS, `ip neigh`/`fping` on Linux).

## Deployment on the Pi

```bash
git clone <this repo> ~/about-us-network-monitor
cd ~/about-us-network-monitor
sudo bash deploy/install.sh
```

That installs Node 22, `fping`, `snmp`, `lldpd`, builds the app into
`/opt/about-us-network-monitor`, and starts the `aboutus-net-monitor` systemd
service on port 80. Details, VLAN sub-interfaces, hostname/DNS and
troubleshooting: [docs/deployment.md](docs/deployment.md).

```bash
sudo systemctl status aboutus-net-monitor
sudo journalctl -u aboutus-net-monitor -f
sudo bash /opt/about-us-network-monitor/deploy/update.sh   # after pulling new code
```

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` / `npm run dev:demo` | Backend + UI with hot reload (live / simulated network) |
| `npm run build` | Build UI (`web/dist`) and backend bundle (`server/dist/index.js`) |
| `npm start` / `npm run start:demo` | Run the built backend (serves the UI) |
| `npm run check` | Typecheck + lint + tests |
| `npm test` | Unit tests (parsers, port mapping, diffs, scheduler) and an end-to-end analysis run on the demo network |
| `npm run snmp:probe -- 192.168.99.11 aboutusdell` | Verify an SNMP community and print how a device names its ports |

Environment variables for the backend: `PORT` (80), `HOST` (0.0.0.0),
`DATA_DIR` (`./data`), `INVENTORY_FILE` (`config/inventory.json`),
`MONITOR_MODE=demo`, `LOG_LEVEL=debug|info|warn|error`.

## Layout

```
config/inventory.json   planned inventory (planner export) — the reference, not the truth
shared/                 API types, MAC/IP helpers, port layout (used by server and web)
server/                 Node backend: pollers, scheduler, analysis, HTTP + SSE
web/                    React UI (Vite, Tailwind, React Flow)
deploy/                 systemd unit, install.sh, update.sh
docs/                   architecture, polling strategy, deployment, API
data/                   runtime state on the Pi (settings, known devices, events) — git-ignored
```

See [docs/architecture.md](docs/architecture.md), [docs/polling.md](docs/polling.md)
and [docs/api.md](docs/api.md).
