import { createSocket, type Socket } from 'node:dgram'
import type { Store } from '../state/store.js'
import { log } from '../logger.js'

const logger = log('syslog')

const SEVERITY_NAMES = ['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug']

/**
 * Optional UDP syslog receiver so switch/router messages (link changes,
 * logins, STP events) show up in the event timeline. Off by default; the
 * default port 5514 needs no root — point the devices at it.
 */
export class SyslogReceiver {
  private socket: Socket | null = null

  constructor(private readonly store: Store) {}

  start(port: number) {
    this.stop()
    const socket = createSocket('udp4')
    socket.on('message', (message, remote) => this.handle(message.toString('utf8'), remote.address))
    socket.on('error', (error) => {
      logger.warn(`receiver error: ${error.message}`)
      this.stop()
    })
    socket.bind(port, () => logger.info(`listening on udp/${port}`))
    this.socket = socket
  }

  stop() {
    this.socket?.close()
    this.socket = null
  }

  private handle(raw: string, from: string) {
    const match = raw.match(/^<(\d+)>(.*)$/s)
    const priority = match ? Number(match[1]) : 6 * 8 + 6
    const severity = priority % 8
    const text = (match ? match[2]! : raw).trim().slice(0, 300)
    const device = this.store.inventory.devices.find((item) => item.managementIp === from)
    const label = device?.name ?? from
    // Only surface what a technician cares about; debug chatter stays out of the timeline.
    if (severity > 5) return
    this.store.addEvent({
      kind: 'syslog',
      severity: severity <= 3 ? 'critical' : severity === 4 ? 'warning' : 'info',
      message: `${label}: ${text} [${SEVERITY_NAMES[severity]}]`,
      subject: device
        ? { type: 'infra', id: device.id, label: device.name, href: device.type === 'switch' ? `/switches/${device.id}` : '/overview' }
        : null,
    })
  }
}
