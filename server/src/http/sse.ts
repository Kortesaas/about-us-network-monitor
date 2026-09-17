import type { Response } from 'express'
import type { LiveMessage } from '@shared/types'

/**
 * Server-Sent Events fan-out. Browsers subscribe once and are told *that*
 * something changed; they then fetch `/api/state`. Cheap for the Pi even with
 * a dozen phones and laptops open.
 */
export class LiveChannel {
  private clients = new Set<Response>()
  private heartbeat: NodeJS.Timeout

  constructor() {
    this.heartbeat = setInterval(() => this.broadcast({ type: 'ping' }), 20_000)
    this.heartbeat.unref()
  }

  subscribe(res: Response, hello: LiveMessage) {
    res.status(200)
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()
    res.write(`retry: 3000\n\n`)
    this.send(res, hello)
    this.clients.add(res)
    res.on('close', () => this.clients.delete(res))
  }

  broadcast(message: LiveMessage) {
    for (const client of this.clients) this.send(client, message)
  }

  get size() {
    return this.clients.size
  }

  private send(res: Response, message: LiveMessage) {
    try {
      res.write(`event: ${message.type}\ndata: ${JSON.stringify(message)}\n\n`)
    } catch {
      this.clients.delete(res)
    }
  }

  close() {
    clearInterval(this.heartbeat)
    for (const client of this.clients) client.end()
    this.clients.clear()
  }
}
