import type { DeviceState, InfraState, InternetState, Problem, ProblemSeverity, SwitchState, VlanState, WlanState } from '@shared/types'
import type { Store } from '../state/store.js'
import { isApTrunk } from './switches.js'
import { plannedSpeedMbps } from '../poll/snmp/vendor.js'

type Draft = Omit<Problem, 'since' | 'lastSeenAt'>

/** Times inside problem texts use the Pi's local clock — the same clock the crew is on. */
const clock = (iso: string | null) => {
  if (!iso) return 'unknown'
  const date = new Date(iso)
  const sameDay = date.toDateString() === new Date().toDateString()
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  return sameDay ? time : `${date.toLocaleDateString()} ${time}`
}

/**
 * Production checks. Every problem explains what is wrong, why it matters
 * during a show, and what to do — the audience is a technician under time
 * pressure, not a network engineer with a MIB browser.
 */
export function buildProblems(
  store: Store,
  switches: SwitchState[],
  infra: InfraState[],
  devices: DeviceState[],
  vlans: VlanState[],
  internet: InternetState,
  wlan: WlanState,
  now: number,
): Problem[] {
  const drafts: Draft[] = []
  const add = (draft: Draft) => drafts.push(draft)
  const { thresholds } = store.settings
  const vlanName = (id: number | null) => (id === null ? '—' : `${id} ${vlans.find((vlan) => vlan.vlanId === id)?.name ?? ''}`.trim())

  /* ---- infrastructure ---- */
  for (const item of infra) {
    if (!item.inUse) continue
    const href = item.type === 'switch' ? `/switches/${item.id}` : '/overview'
    const subject = { type: 'infra' as const, id: item.id, label: item.name, href }
    if (item.reachability === 'offline')
      add({
        id: `infra-offline:${item.id}`,
        code: 'infra-offline',
        severity: item.type === 'access-point' ? 'warning' : 'critical',
        title: `${item.name} is unreachable`,
        detail: `${item.managementIp} has not answered pings${item.lastSeenAt ? ` since ${clock(item.lastSeenAt)}` : ' at all'}.`,
        suggestion:
          item.type === 'access-point'
            ? 'Check PoE / power on the AP and that its switch port is up. If the AP was never given this IP, fix the inventory address.'
            : 'Check power and the uplink to this device. If it is fine on site, verify the management IP in the inventory and that VLAN 99 reaches the Pi.',
        subject,
      })
    else if (item.reachability === 'stale')
      add({
        id: `infra-stale:${item.id}`,
        code: 'infra-stale',
        severity: 'warning',
        title: `${item.name} missed recent pings`,
        detail: `${item.managementIp} answered before but not on the last attempts.`,
        suggestion: 'Usually a reboot or a flapping link. Watch it; if it stays stale it becomes an outage.',
        subject,
      })
    // Only after a poll actually failed — right after start-up "no data yet" is not a problem.
    if (item.snmp && item.snmp.enabled && !item.snmp.ok && item.snmp.lastError && item.reachability !== 'offline')
      add({
        id: `snmp-failed:${item.id}`,
        code: 'snmp-failed',
        severity: item.type === 'switch' ? 'warning' : 'info',
        title: `No SNMP data from ${item.name}`,
        detail: item.snmp.lastError
          ? `Last error: ${item.snmp.lastError}.`
          : item.snmp.lastOkAt
            ? `Last successful poll at ${clock(item.snmp.lastOkAt)}.`
            : 'No successful poll yet.',
        suggestion:
          item.type === 'switch'
            ? 'Port maps, VLAN checks and device locations for this switch are blind. Check the SNMP community in Settings and that SNMP v2c is enabled on the switch.'
            : 'Optional for this device type. Enable SNMP on it or disable the target in Settings to silence this.',
        subject,
      })
  }

  /* ---- planned patching: an infra device whose planned port names it (planner "connected device" or port label) ---- */
  const firstWords = new Map<string, number>()
  for (const device of store.inventory.devices) {
    const word = device.name.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
    if (word) firstWords.set(word, (firstWords.get(word) ?? 0) + 1)
  }
  const plannedPortFor = (deviceId: string, name: string) => {
    const lower = name.trim().toLowerCase()
    const word = lower.split(/\s+/)[0] ?? ''
    for (const sw of switches)
      for (const port of sw.ports) {
        if (!port.planned) continue
        const connected = port.planned.connectedDevice.trim().toLowerCase()
        const label = port.planned.name.trim().toLowerCase()
        if ((connected && (connected === deviceId.toLowerCase() || connected === lower)) || (label && (label === lower || (label === word && word.length >= 2 && firstWords.get(word) === 1))))
          return { switchId: sw.id, switchName: sw.name, port: port.number, label: port.planned.name }
      }
    return null
  }
  for (const item of infra) {
    if (!item.inUse || !item.locatedAt) continue
    const planned = plannedPortFor(item.id, item.name)
    if (!planned || (planned.switchId === item.locatedAt.switchId && planned.port === item.locatedAt.port)) continue
    add({
      id: `infra-wrong-port:${item.id}`,
      code: 'infra-wrong-port',
      severity: 'warning',
      title: `${item.name} is on ${item.locatedAt.switchName} port ${item.locatedAt.port}, planned ${planned.switchName} port ${planned.port}`,
      detail: `The plan reserves ${planned.switchName} port ${planned.port} ("${planned.label}") for it. On another port it may miss the VLANs it needs.`,
      suggestion: `Patch ${item.name} to ${planned.switchName} port ${planned.port}, or update the plan if this is intentional.`,
      subject: { type: 'infra' as const, id: item.id, label: item.name, href: `/switches/${item.locatedAt.switchId}?port=${item.locatedAt.port}` },
    })
  }

  /* ---- this Pi: every address must belong to a planned subnet ---- */
  for (const iface of store.backend.interfaces)
    if (iface.vlanId === null && !iface.ip.startsWith('127.') && !iface.ip.startsWith('169.254.'))
      add({
        id: `pi-unplanned-ip:${iface.name}`,
        code: 'pi-unplanned-ip',
        severity: 'warning',
        title: `The Pi has an address outside the plan: ${iface.cidr} on ${iface.name}`,
        detail: 'No planned subnet contains this address, so the monitor cannot tell which VLAN this interface is in.',
        suggestion: 'Fix the interface configuration (see docs/deployment.md) or add the subnet to the plan.',
        subject: { type: 'system' as const, id: 'pi', label: 'Pi', href: '/settings#discovery' },
      })

  /* ---- access points ---- */
  for (const ap of wlan.accessPoints) {
    // Only planned APs in the setup, only after a poll actually failed, and only while the AP itself answers pings.
    if (!ap.inUse || !ap.poll || ap.poll.ok || !ap.poll.at || ap.reachability === 'offline') continue
    const error = ap.poll.error ?? 'unknown error'
    const auth = /login|password/i.test(error)
    add({
      id: `ap-poll-failed:${ap.id}`,
      code: 'ap-poll-failed',
      severity: auth ? 'warning' : 'info',
      title: `No Wi-Fi data from ${ap.name}`,
      detail: `${error}.${ap.poll.lastOkAt ? ` Last successful read at ${clock(ap.poll.lastOkAt)}.` : ' No successful read yet.'} Devices on this AP show no SSID or signal and may appear unlocated.`,
      suggestion: auth
        ? 'Check the access point username/password under Settings → Integrations. The monitor waits 10 minutes after a rejected login so it never locks the AP; saving the settings retries at once.'
        : 'The AP answers pings but not its web API — it may be rebooting, adopted by a controller (then use the Omada integration), or not a standalone Omada EAP.',
      subject: { type: 'infra', id: ap.id, label: ap.name, href: '/wlan' },
    })
  }

  /* ---- internet ---- */
  if (internet.enabled && internet.status === 'offline')
    add({
      id: 'internet-down',
      code: 'internet-down',
      severity: 'warning',
      title: 'No internet connection',
      detail: `${internet.targets.map((target) => target.target).join(' and ')} do not answer from the Pi. The show network itself is unaffected; anything that needs the WAN (streaming, remote support, licences, cloud consoles) is.`,
      suggestion: 'Check the WAN uplink into the router (VLAN 90 / WAN port) and the router\'s internet status page.',
      subject: { type: 'system', id: 'internet', label: 'Internet', href: '/overview' },
    })
  else if (internet.enabled && internet.status === 'online' && internet.dns.ok === false)
    add({
      id: 'dns-failed',
      code: 'dns-failed',
      severity: 'warning',
      title: `DNS is not resolving (${internet.dns.host})`,
      detail: `The internet answers pings but the Pi cannot resolve names${internet.dns.error ? `: ${internet.dns.error}` : ''}. Resolver${internet.dns.resolvers.length === 1 ? '' : 's'}: ${internet.dns.resolvers.join(', ') || 'unknown'}.`,
      suggestion: 'Check the DNS server handed out by DHCP (planned 10.10.99.2 / the router) and the router\'s upstream DNS.',
      subject: { type: 'system', id: 'dns', label: 'DNS', href: '/overview' },
    })

  /* ---- gateways ---- */
  for (const vlan of vlans) {
    if (!vlan.subnet?.gateway || vlan.gatewayReachability === null) continue
    if (vlan.gatewayReachability === 'offline')
      add({
        id: `gateway-unreachable:${vlan.vlanId}`,
        code: 'gateway-unreachable',
        severity: 'critical',
        title: `Gateway ${vlan.subnet.gateway} for VLAN ${vlan.vlanId} ${vlan.name} is unreachable`,
        detail: 'Clients in this VLAN cannot reach other networks or DHCP relayed through the router.',
        suggestion: 'Check the router and the trunk carrying this VLAN to it. If the Pi has no interface in this VLAN, reachability is via routing — a WAN-only VLAN may be expected to fail.',
        subject: { type: 'vlan', id: String(vlan.vlanId), label: `VLAN ${vlan.vlanId}`, href: `/vlans?vlan=${vlan.vlanId}` },
      })
  }

  /* ---- switches & ports ---- */
  for (const sw of switches) {
    if (!sw.snmp.ok || !store.isInUse(sw.id)) continue
    const subjectFor = (port: number, label: string) => ({
      type: 'port' as const,
      id: `${sw.id}:${port}`,
      label: `${sw.name} · port ${port}${label ? ` (${label})` : ''}`,
      href: `/switches/${sw.id}?port=${port}`,
    })
    if (sw.vlans.length)
      // Only VLANs with a planned subnet are expected on every switch; WAN passthrough VLANs live on a few ports.
      for (const vlan of vlans.filter((item) => item.planned && item.subnet))
        if (!sw.vlans.some((item) => item.vlanId === vlan.vlanId))
          add({
            id: `vlan-missing:${sw.id}:${vlan.vlanId}`,
            code: 'vlan-missing',
            severity: 'warning',
            title: `VLAN ${vlan.vlanId} ${vlan.name} is not configured on ${sw.name}`,
            detail: 'The plan expects this VLAN on every switch, but the switch does not know it — ports assigned to it will not work.',
            suggestion: `Create VLAN ${vlan.vlanId} on the switch and add it to the trunks.`,
            subject: { type: 'switch', id: sw.id, label: sw.name, href: `/switches/${sw.id}` },
          })

    for (const port of sw.ports) {
      const planned = port.planned
      const label = planned?.name ?? ''
      const subject = subjectFor(port.number, label)
      for (const diff of port.diffs) {
        if (diff.kind === 'mode')
          add({
            id: `port-mode:${sw.id}:${port.number}`,
            code: 'port-mode-mismatch',
            severity: 'warning',
            title: `${sw.name} port ${port.number} is ${diff.discovered}, planned ${diff.planned}`,
            detail: `The plan says ${diff.planned}${label ? ` (${label})` : ''}; the switch reports ${diff.discovered} mode.`,
            suggestion: diff.planned === 'access' ? 'A device on this port may be seeing tagged traffic it cannot use. Reconfigure the port as access.' : 'A trunk configured as access drops every tagged VLAN — uplinks and APs break. Reconfigure the port as trunk.',
            subject,
          })
        if (diff.kind === 'access-vlan')
          add({
            id: `access-vlan:${sw.id}:${port.number}`,
            code: 'access-vlan-mismatch',
            severity: 'warning',
            title: `${sw.name} port ${port.number} is in VLAN ${vlanName(diff.discovered)}, planned ${vlanName(diff.planned)}`,
            detail: `Anything plugged in here lands in the wrong network${label ? ` (label "${label}")` : ''}.`,
            suggestion: `Set the access VLAN of port ${port.number} to ${diff.planned}, or update the plan if this change is intentional.`,
            subject,
          })
        if (diff.kind === 'native-vlan')
          add({
            id: `native-vlan:${sw.id}:${port.number}`,
            code: isApTrunk(planned) ? 'ap-trunk-mismatch' : 'native-vlan-mismatch',
            severity: 'warning',
            title: `${sw.name} port ${port.number} native VLAN is ${vlanName(diff.discovered)}, planned ${vlanName(diff.planned)}`,
            detail: isApTrunk(planned)
              ? 'The access point expects untagged management traffic on VLAN 99. With another native VLAN the AP will not get its management IP.'
              : 'Untagged traffic on this trunk lands in the wrong VLAN.',
            suggestion: `Set the PVID / native VLAN of port ${port.number} to ${diff.planned}.`,
            subject,
          })
        if (diff.kind === 'missing-tagged')
          add({
            id: `trunk-missing:${sw.id}:${port.number}`,
            code: isApTrunk(planned) ? 'ap-trunk-mismatch' : 'trunk-missing-vlan',
            severity: 'warning',
            title: `${sw.name} port ${port.number} is missing VLAN ${diff.vlanIds.join(', ')}`,
            detail: isApTrunk(planned)
              ? `Wi-Fi clients on SSIDs mapped to VLAN ${diff.vlanIds.join(', ')} will have no network.`
              : `Devices in VLAN ${diff.vlanIds.map(vlanName).join(', ')} behind this trunk cannot cross it.`,
            suggestion: `Add VLAN ${diff.vlanIds.join(', ')} tagged to port ${port.number}.`,
            subject,
          })
        if (diff.kind === 'extra-tagged')
          add({
            id: `trunk-extra:${sw.id}:${port.number}`,
            code: 'trunk-extra-vlan',
            severity: 'info',
            title: `${sw.name} port ${port.number} carries unplanned VLAN ${diff.vlanIds.join(', ')}`,
            detail: 'Extra VLANs on a trunk are usually harmless but widen the broadcast domain and can leak WAN traffic into the show network.',
            suggestion: 'Remove the VLAN from the trunk if it is not needed, or add it to the plan.',
            subject,
          })
      }

      // Not every planned trunk is patched on every job: only a trunk that had link in this setup and lost it is a problem.
      const seenUp = store.portsSeenUp.has(`${sw.id}:${port.number}`)
      if (planned?.mode === 'trunk' && port.link && !port.link.operUp && !isApTrunk(planned) && seenUp)
        add({
          id: `uplink-down:${sw.id}:${port.number}`,
          code: 'uplink-down',
          severity: 'warning',
          title: `Trunk ${sw.name} port ${port.number}${label ? ` (${label})` : ''} lost link`,
          detail: 'This trunk had link earlier in this setup and lost it. Everything behind it is cut off.',
          suggestion: 'Check the cable and the far end. If it was unplugged on purpose, click Resolve to accept it for this setup.',
          subject,
        })
      if (isApTrunk(planned) && port.link && !port.link.operUp && seenUp)
        add({
          id: `ap-port-down:${sw.id}:${port.number}`,
          code: 'ap-port-down',
          severity: 'warning',
          title: `AP port ${sw.name} ${port.number} lost link`,
          detail: 'The access point on this port had link earlier in this setup and lost it — no Wi-Fi from it.',
          suggestion: 'Check PoE and the cable to the AP. If it was unplugged on purpose, click Resolve to accept it for this setup.',
          subject,
        })
      if (port.lldp.length && planned?.mode === 'access' && port.lldp.some((n) => /switch|router/i.test(n.sysDescription) || n.deviceId))
        add({
          id: `lldp-on-access:${sw.id}:${port.number}`,
          code: 'lldp-mismatch',
          severity: 'warning',
          title: `${port.lldp[0]!.sysName || 'A switch/router'} is connected to access port ${port.number} on ${sw.name}`,
          detail: 'LLDP shows infrastructure on a port planned as a plain access port. Only one VLAN crosses this link.',
          suggestion: 'Move the cable to a trunk port or reconfigure this port as a trunk.',
          subject,
        })
      if (port.rates && port.rates.errorsPerMin > thresholds.portErrorsPerMinute)
        {
          // Discards with clean CRC/error counters are a configuration problem, not a cable: the switch
          // receives valid frames and drops them on ingress — almost always tagged VLANs the port is not a member of.
          const counters = port.counters
          const onlyDiscards = counters !== null && counters.inErrors + counters.outErrors === 0 && counters.inDiscards + counters.outDiscards > 0
          const silent = port.macs.length === 0 && port.lldp.length === 0
          const trunkLike = planned?.mode === 'trunk' || planned?.mode === 'hybrid' || port.uplink
          // A switch whose only live port is this one has nowhere to flood broadcast/multicast to and counts
          // every such frame as discarded (seen on the T1600G): expected, and gone as soon as a second port has link.
          const lonely = onlyDiscards && sw.ports.filter((item) => item.link?.operUp).length === 1
          add({
            id: `port-errors:${sw.id}:${port.number}`,
            code: 'port-errors',
            severity: lonely ? 'info' : port.uplink || trunkLike ? 'critical' : 'warning',
            title: lonely
              ? `${sw.name} discards flooded traffic on port ${port.number}${label ? ` (${label})` : ''} — nothing else is plugged in`
              : onlyDiscards
                ? `${sw.name} port ${port.number}${label ? ` (${label})` : ''} is discarding incoming frames`
                : `Errors increasing on ${sw.name} port ${port.number}${label ? ` (${label})` : ''}`,
            detail: lonely
              ? `${port.rates.errorsPerMin.toFixed(0)} frames/min: broadcast and multicast arriving on the uplink have no other port to go to while this is the switch's only active link. No errors, nothing is lost that anyone is waiting for.`
              : onlyDiscards
                ? `${port.rates.errorsPerMin.toFixed(0)} frames/min dropped on ingress, no CRC errors${silent ? ', and no MAC has been learned on this port — everything that arrives is thrown away' : ''}. ${trunkLike ? 'On a trunk that usually means tagged VLANs the port is not a member of.' : 'Usually tagged frames on an access port, or a VLAN the port is not a member of.'}`
                : `${port.rates.errorsPerMin.toFixed(1)} errors/discards per minute. ${port.uplink ? 'This is an uplink — every VLAN behind it suffers.' : ''}`.trim(),
            suggestion: lonely
              ? 'Nothing to do. This turns into a real check once a device is connected to the switch.'
              : onlyDiscards
                ? trunkLike
                  ? `Compare the VLAN membership of this port with the far end: it should carry ${planned ? [planned.nativeVlanId !== null ? `${planned.nativeVlanId} untagged` : null, planned.taggedVlanIds.length ? `${planned.taggedVlanIds.join(', ')} tagged` : null].filter(Boolean).join(' and ') || 'the planned VLANs' : 'the same VLANs as the far end'}. If the switch's MAC table shows this port learning in every VLAN, the membership is fine and the discards are flooded frames with no receiver.`
                  : 'Check what is plugged in and whether it sends tagged frames; set the port mode and VLAN to match.'
                : 'Reseat or replace the cable, check for a duplex mismatch and look at the far-end device.',
            subject,
          })
        }
      if (port.link?.operUp && planned?.speed && port.link.speedMbps) {
        const expected = plannedSpeedMbps(planned.speed)
        if (expected && port.link.speedMbps < expected && port.link.speedMbps <= 100)
          add({
            id: `link-slow:${sw.id}:${port.number}`,
            code: 'link-speed-low',
            severity: port.uplink || planned.mode === 'trunk' ? 'warning' : 'info',
            title: `${sw.name} port ${port.number} negotiated only ${port.link.speedMbps} Mbit/s`,
            detail: `Planned ${planned.speed}. Slow links on trunks or Dante ports cause dropouts.`,
            suggestion: 'Swap the cable (needs all 4 pairs for gigabit) and check the far-end port speed setting.',
            subject,
          })
      }
    }
  }

  /* ---- devices ---- */
  const ipClaims = new Map<string, DeviceState[]>()
  for (const device of devices) {
    if (device.macOnly || device.known?.ignored) continue
    const subject = { type: 'device' as const, id: device.id, label: device.name, href: `/devices/${encodeURIComponent(device.id)}` }
    for (const ip of device.ips) {
      const list = ipClaims.get(ip) ?? []
      list.push(device)
      ipClaims.set(ip, list)
    }
    if (device.online && device.location && device.vlanId !== null && device.location.vlanId !== null && device.vlanSource === 'subnet' && device.location.vlanId !== device.vlanId && device.flags.some((flag) => flag.includes('the switch learned it on VLAN')))
      add({
        id: `vlan-mismatch:${device.id}`,
        code: 'device-vlan-mismatch',
        severity: 'warning',
        title: `${device.name} has an IP for VLAN ${device.vlanId} but sits in VLAN ${device.location.vlanId}`,
        detail: `${device.primaryIp} belongs to the ${vlanName(device.vlanId)} subnet, yet ${device.location.switchName} port ${device.location.port} learned it on VLAN ${device.location.vlanId}. It probably has a static IP from the wrong network.`,
        suggestion: `Move it to a ${vlanName(device.vlanId)} port or give it an address from VLAN ${device.location.vlanId}.`,
        subject,
      })
    if (!device.online && (device.known?.favorite || device.infraId === null && device.known) && device.status === 'offline')
      add({
        id: `device-offline:${device.id}`,
        code: 'device-offline',
        severity: device.known?.favorite ? 'warning' : 'info',
        title: `${device.name} is offline`,
        detail: `Last seen ${clock(device.lastSeenAt)}${device.location ? ` on ${device.location.switchName} port ${device.location.port}` : ''}.`,
        suggestion: 'Check power and the cable at its last known port.',
        subject,
      })
    if (device.online && device.vlanId === 99 && !device.infraId && !device.known)
      add({
        id: `unknown-on-mgmt:${device.id}`,
        code: 'unknown-on-management',
        severity: 'info',
        title: `Unknown device ${device.name} on the management VLAN`,
        detail: `${device.primaryIp ?? device.primaryMac} is in VLAN 99 but is not planned infrastructure and has no metadata.`,
        suggestion: 'Name it in Devices if it belongs there; otherwise move it to its show VLAN.',
        subject,
      })
    if (device.status === 'relocating')
      add({
        id: `relocating:${device.id}`,
        code: 'device-moved',
        severity: 'info',
        title: `${device.name} moved to ${device.location?.switchName} port ${device.location?.port}`,
        detail: device.previousLocation ? `Previously on ${device.previousLocation.switchName} port ${device.previousLocation.port}.` : 'Its port changed recently.',
        suggestion: 'Expected during setup. If nobody re-patched it, a MAC is appearing on two ports — check for a loop or a duplicated MAC.',
        subject,
      })
  }
  for (const [ip, claimants] of ipClaims) {
    const online = claimants.filter((device) => device.online)
    if (online.length < 2) continue
    add({
      id: `duplicate-ip:${ip}`,
      code: 'duplicate-ip',
      severity: 'critical',
      title: `Duplicate IP ${ip}`,
      detail: `${online.map((device) => `${device.name} (${device.primaryMac ?? 'no MAC'})`).join(' and ')} both use ${ip}. Traffic will randomly reach the wrong one.`,
      suggestion: 'Give one of them a different static address or fix the DHCP reservation.',
      subject: { type: 'device', id: online[0]!.id, label: online[0]!.name, href: `/devices?q=${ip}` },
    })
  }

  const order: Record<ProblemSeverity, number> = { critical: 0, warning: 1, info: 2 }
  const nowIso = new Date(now).toISOString()
  return drafts
    .map((draft) => ({ ...draft, since: store.problemsSince.get(draft.id) ?? nowIso, lastSeenAt: nowIso }))
    .sort((a, b) => order[a.severity] - order[b.severity] || a.since.localeCompare(b.since))
}
