# Deployment on the Raspberry Pi

Target: Raspberry Pi 4 (8 GB), Raspberry Pi OS Bookworm (64-bit), hostname
`aboutus-net`, static address `192.168.99.2/24` on VLAN 99, plugged into the
FOH switch's **PI** trunk port (native 99, tagged 10/20/30/40).

## 1. Base system

```bash
sudo hostnamectl set-hostname aboutus-net
sudo raspi-config        # locale/timezone; the Pi's clock is what problem texts show
```

Static IP with NetworkManager (Bookworm default):

```bash
sudo nmcli con mod "Wired connection 1" ipv4.method manual \
  ipv4.addresses 192.168.99.2/24 ipv4.gateway 192.168.99.1 ipv4.dns 192.168.99.1
sudo nmcli con up "Wired connection 1"
```

### Optional but recommended: VLAN sub-interfaces

The Pi's trunk port carries every show VLAN. With a sub-interface per VLAN the
Pi can ping-sweep and ARP each VLAN directly (fastest, most reliable discovery).
Without them the monitor still works — it uses the router's ARP table over SNMP
and routed pings — but "confirmed alive" then depends on the router.

```bash
for v in 10 20 30 40; do
  sudo nmcli con add type vlan con-name vlan$v ifname eth0.$v dev eth0 id $v \
    ipv4.method manual ipv4.addresses 192.168.$v.2/24 ipv4.never-default yes
done
```

Pick addresses outside the DHCP ranges (`.100–.199`); `.2` is reserved in every
planned subnet. The Overview → Backend panel lists which interfaces/VLANs the
Pi has.

## 2. Install the monitor

```bash
sudo apt install -y git
git clone <repo-url> ~/about-us-network-monitor
cd ~/about-us-network-monitor
sudo bash deploy/install.sh
```

The installer:

* installs `fping` (paced sweeps), `snmp` (`snmpwalk` for troubleshooting),
  `lldpd` (so the switches — and therefore the monitor — can see the Pi), and
  Node.js 22 if missing;
* copies the app to `/opt/about-us-network-monitor`, builds it, prunes dev
  dependencies;
* creates the `aboutus` service user and `/var/lib/aboutus-net-monitor` for
  settings / known devices / events;
* installs and starts `aboutus-net-monitor.service` on **port 80** (bound via
  `CAP_NET_BIND_SERVICE`, no root).

Check:

```bash
sudo systemctl status aboutus-net-monitor
curl -s http://127.0.0.1/api/health
```

Then open http://192.168.99.2 from any device on the network.

## 3. Name resolution: `http://aboutus-net`

* **Router DNS (recommended):** on the LANCOM add a static DNS host entry
  `aboutus-net → 192.168.99.2` (Configuration → IPv4 → DNS → Station names).
  DHCP clients in every VLAN then resolve `aboutus-net`.
* **mDNS fallback:** `http://aboutus-net.local` works on macOS/iOS/most Linux
  without any router config (`avahi-daemon` ships with Raspberry Pi OS).
  Windows needs Bonjour or the router entry.

## 4. Switches and router

* Enable **SNMP v2c read-only** with the planned communities:
  Dell N1524/P `aboutusdell`, Allied AT-GS950/48 `aboutusmon`, TP-Link T1600G
  `aboutustplink`, LANCOM 1783VAW `aboutusrouter`. Restrict them to
  `192.168.99.2` where the device allows it.
* Enable **LLDP** on every switch port (Dell and TP-Link have it on by default).
* Optionally point **syslog** at `192.168.99.2:5514` (UDP) and enable the
  receiver in Settings → Integrations to see switch log messages in Events.
* Verify a community from the Pi:

  ```bash
  cd /opt/about-us-network-monitor
  npx tsx server/scripts/snmp-probe.ts 192.168.99.11 aboutusdell
  ```

  It prints sysDescr, the interface names (so you can confirm the port mapping),
  the VLAN table, FDB size and LLDP neighbours.

## 5. Operations

| Task | Command |
| --- | --- |
| Logs (live) | `sudo journalctl -u aboutus-net-monitor -f` |
| Restart | `sudo systemctl restart aboutus-net-monitor` |
| Update after new code | `git pull` in the checkout, then `sudo bash deploy/update.sh ~/about-us-network-monitor` |
| Change port | edit `Environment=PORT=` in `/etc/systemd/system/aboutus-net-monitor.service`, `daemon-reload`, restart |
| Debug logging | `Environment=LOG_LEVEL=debug` in the unit |
| Back up settings + known devices | Settings → Backup → Download (or copy `/var/lib/aboutus-net-monitor`) |
| Replace the plan | Settings → Inventory → Upload planner JSON (stored in `/var/lib/aboutus-net-monitor/inventory.json`) |
| Demo mode on the Pi | `Environment=MONITOR_MODE=demo` in the unit (never for the show) |

## Troubleshooting

* **"Backend unreachable" in the browser** — service down or wrong host:
  `systemctl status`, `journalctl`, `curl http://127.0.0.1/api/health`.
* **A switch shows "SNMP failed"** — wrong community, SNMP disabled, or an ACL:
  run the probe above; the exact error is on the switch card and in Settings →
  Polling → Scheduled jobs.
* **Port numbers look shifted** — check the switch inspector's *Port mapping*
  note; run the probe with `--walk 1.3.6.1.2.1.31.1.1.1.1` and compare with
  the front panel. `vendor.ts` documents the naming rules.
* **Devices are "unlocated"** — the FDB poll is 2 min by default; the device may
  sit behind an uplink of a switch without SNMP (Allied without community), or
  behind an AP (then Omada integration adds the AP/SSID).
* **Everything in VLAN 10/20/30/40 is missing** — the Pi has no interface there
  and the router ARP job fails. Fix the router community or add VLAN
  sub-interfaces (section 1).
* **Port 80 permission denied** — the unit's `AmbientCapabilities` line was
  removed, or the service runs from another unit; use `PORT=8080`.
