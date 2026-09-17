# Screens

Run `npm run dev:demo` and open http://localhost:5174 to see every screen with
simulated data. The demo scenario contains:

* an unreachable switch (Dell FOH Jakob) → critical;
* a switch that answers pings but not SNMP (Allied) → warning;
* Dell FOH Manu port 23 with native VLAN 1 instead of 99;
* Dell Stage A port 9 configured as CONTROL although planned AUDIO;
* Dell Stage A AP trunk missing VLAN 40;
* TP-Link port 22 carrying an unplanned VLAN 90, port 3 with increasing errors;
* a Dante device with an AUDIO address plugged into a LIGHT port;
* a duplicate IP (192.168.10.150) that flips in the router's ARP table;
* a laptop that changes ports every four minutes (relocating);
* a media server that goes offline for two minutes every ten;
* a flapping access point (stale);
* a device that is online but only reachable behind the offline switch (unlocated);
* MAC-only observations without an IP.
