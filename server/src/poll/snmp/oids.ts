/** Standard MIB OIDs the pollers rely on. Vendor-specific ones live in vendor.ts. */
export const OID = {
  sysDescr: '1.3.6.1.2.1.1.1.0',
  sysObjectID: '1.3.6.1.2.1.1.2.0',
  sysUpTime: '1.3.6.1.2.1.1.3.0',
  sysName: '1.3.6.1.2.1.1.5.0',
  sysLocation: '1.3.6.1.2.1.1.6.0',

  ifDescr: '1.3.6.1.2.1.2.2.1.2',
  ifType: '1.3.6.1.2.1.2.2.1.3',
  ifPhysAddress: '1.3.6.1.2.1.2.2.1.6',
  ifAdminStatus: '1.3.6.1.2.1.2.2.1.7',
  ifOperStatus: '1.3.6.1.2.1.2.2.1.8',
  ifLastChange: '1.3.6.1.2.1.2.2.1.9',
  ifInDiscards: '1.3.6.1.2.1.2.2.1.13',
  ifInErrors: '1.3.6.1.2.1.2.2.1.14',
  ifOutDiscards: '1.3.6.1.2.1.2.2.1.19',
  ifOutErrors: '1.3.6.1.2.1.2.2.1.20',
  ifInOctets: '1.3.6.1.2.1.2.2.1.10',
  ifOutOctets: '1.3.6.1.2.1.2.2.1.16',

  ifName: '1.3.6.1.2.1.31.1.1.1.1',
  ifHCInOctets: '1.3.6.1.2.1.31.1.1.1.6',
  ifHCOutOctets: '1.3.6.1.2.1.31.1.1.1.10',
  ifHighSpeed: '1.3.6.1.2.1.31.1.1.1.15',
  ifAlias: '1.3.6.1.2.1.31.1.1.1.18',

  /** ARP / neighbour table of a router: ipNetToMediaPhysAddress.<ifIndex>.<ip> */
  ipNetToMediaPhysAddress: '1.3.6.1.2.1.4.22.1.2',
  ipNetToMediaType: '1.3.6.1.2.1.4.22.1.4',

  dot1dBasePortIfIndex: '1.3.6.1.2.1.17.1.4.1.2',
  dot1dTpFdbAddress: '1.3.6.1.2.1.17.4.3.1.1',
  dot1dTpFdbPort: '1.3.6.1.2.1.17.4.3.1.2',
  dot1dTpFdbStatus: '1.3.6.1.2.1.17.4.3.1.3',

  dot1qVlanStaticName: '1.3.6.1.2.1.17.7.1.4.3.1.1',
  dot1qVlanStaticEgressPorts: '1.3.6.1.2.1.17.7.1.4.3.1.2',
  dot1qVlanStaticUntaggedPorts: '1.3.6.1.2.1.17.7.1.4.3.1.4',
  dot1qVlanCurrentEgressPorts: '1.3.6.1.2.1.17.7.1.4.2.1.4',
  dot1qVlanCurrentUntaggedPorts: '1.3.6.1.2.1.17.7.1.4.2.1.5',
  dot1qPvid: '1.3.6.1.2.1.17.7.1.4.5.1.1',
  dot1qTpFdbPort: '1.3.6.1.2.1.17.7.1.2.2.1.2',
  dot1qTpFdbStatus: '1.3.6.1.2.1.17.7.1.2.2.1.3',

  lldpLocPortIdSubtype: '1.0.8802.1.1.2.1.3.7.1.2',
  lldpLocPortId: '1.0.8802.1.1.2.1.3.7.1.3',
  lldpLocPortDesc: '1.0.8802.1.1.2.1.3.7.1.4',
  lldpRemChassisIdSubtype: '1.0.8802.1.1.2.1.4.1.1.4',
  lldpRemChassisId: '1.0.8802.1.1.2.1.4.1.1.5',
  lldpRemPortIdSubtype: '1.0.8802.1.1.2.1.4.1.1.6',
  lldpRemPortId: '1.0.8802.1.1.2.1.4.1.1.7',
  lldpRemPortDesc: '1.0.8802.1.1.2.1.4.1.1.8',
  lldpRemSysName: '1.0.8802.1.1.2.1.4.1.1.9',
  lldpRemSysDesc: '1.0.8802.1.1.2.1.4.1.1.10',
  lldpRemManAddrIfSubtype: '1.0.8802.1.1.2.1.4.2.1.3',
} as const

/** IANAifType values that are physical Ethernet ports. */
export const ETHERNET_IF_TYPES = new Set([6, 62, 117])
