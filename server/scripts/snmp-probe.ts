/**
 * Quick SNMP probe to verify a community and see how a device names its ports —
 * run this on the Pi before trusting a port map.
 *
 *   npm run snmp:probe -- 192.168.99.11 aboutusdell
 *   npm run snmp:probe -- 192.168.99.21 aboutustplink --walk 1.3.6.1.2.1.31.1.1.1.1
 */
import { NetSnmpTransport, asString, column } from '../src/poll/snmp/client.js'
import { OID } from '../src/poll/snmp/oids.js'

const [host, community, ...rest] = process.argv.slice(2)
if (!host || !community) {
  console.error('usage: snmp-probe <host> <community> [--walk <oid>] [--v1]')
  process.exit(1)
}
const walkIndex = rest.indexOf('--walk')
const customWalk = walkIndex >= 0 ? rest[walkIndex + 1] : null
const version = rest.includes('--v1') ? '1' : '2c'

const transport = new NetSnmpTransport()
const session = transport.open({ host, community, version, port: 161, timeoutMs: 2500, retries: 1 })

async function main() {
  const started = Date.now()
  const sys = await session.get([OID.sysDescr, OID.sysName, OID.sysUpTime, OID.sysLocation])
  console.log(`sysDescr:    ${asString(sys[0]?.value ?? null)}`)
  console.log(`sysName:     ${asString(sys[1]?.value ?? null)}`)
  console.log(`sysLocation: ${asString(sys[3]?.value ?? null)}`)
  console.log(`sysUpTime:   ${sys[2]?.value}`)

  if (customWalk) {
    const rows = await session.walk(customWalk)
    for (const row of rows) console.log(row.oid, '=', Buffer.isBuffer(row.value) ? `${JSON.stringify(row.value.toString('utf8'))} (${row.value.toString('hex')})` : row.value)
    console.log(`${rows.length} rows in ${Date.now() - started} ms`)
  } else {
    const names = column(await session.walk(OID.ifName), OID.ifName)
    const descr = column(await session.walk(OID.ifDescr), OID.ifDescr)
    const types = column(await session.walk(OID.ifType), OID.ifType)
    const oper = column(await session.walk(OID.ifOperStatus), OID.ifOperStatus)
    console.log('\nifIndex  type  oper  ifName / ifDescr')
    for (const key of new Set([...names.keys(), ...descr.keys()])) {
      const type = types.get(key)
      console.log(`${key.padEnd(8)} ${String(type ?? '?').padEnd(5)} ${oper.get(key) === 1 ? 'up  ' : 'down'}  ${asString(names.get(key) ?? null) ?? ''} / ${asString(descr.get(key) ?? null) ?? ''}`)
    }
    const vlans = column(await session.walk(OID.dot1qVlanStaticName), OID.dot1qVlanStaticName)
    console.log(`\nVLANs (dot1qVlanStaticName): ${[...vlans.entries()].map(([id, name]) => `${id}=${asString(name)}`).join(', ') || 'none / unsupported'}`)
    const fdb = await session.walk(OID.dot1qTpFdbPort)
    console.log(`FDB entries (dot1qTpFdbPort): ${fdb.length}`)
    const lldp = await session.walk(OID.lldpRemSysName)
    console.log(`LLDP neighbours: ${lldp.map((row) => asString(row.value)).join(', ') || 'none'}`)
    console.log(`\nprobe finished in ${Date.now() - started} ms`)
  }
}

main()
  .catch((error) => {
    console.error(`probe failed: ${error instanceof Error ? error.message : error}`)
    process.exitCode = 1
  })
  .finally(() => session.close())
