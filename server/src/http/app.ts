import { existsSync, readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import express, { type Request, type Response, type NextFunction } from 'express'
import { z } from 'zod'
import type { KnownDeviceMeta, ScanScope } from '@shared/types'
import { normalizeMac } from '@shared/mac'
import { config } from '../config.js'
import { log } from '../logger.js'
import type { Store } from '../state/store.js'
import type { Poller } from '../poll/jobs.js'
import { maskSettings, mergeSettings, saveSettings, settingsSchema, unmaskSettings, writeJsonAtomic } from '../settings.js'
import { parseInventory } from '../inventory/plan.js'
import { fetchRemoteInventoryProject, RemoteInventoryError } from '../inventory/remote.js'
import { LiveChannel } from './sse.js'
import { trafficHistory } from '../analysis/traffic.js'

const logger = log('http')

const knownSchema = z.object({
  displayName: z.string().max(80).default(''),
  owner: z.string().max(80).default(''),
  category: z.string().max(40).default(''),
  notes: z.string().max(2000).default(''),
  favorite: z.boolean().default(false),
  ignored: z.boolean().default(false),
  macs: z.array(z.string()).default([]),
  ips: z.array(z.string()).default([]),
})

const scopeSchema = z.object({ scope: z.string().default('all') })

export type AppContext = {
  store: Store
  poller: Poller
  onSettingsChanged: () => void
  onInventoryChanged: () => void
}

export function createApp(ctx: AppContext) {
  const { store, poller } = ctx
  const live = new LiveChannel()
  store.onChange((state, changed) => live.broadcast({ type: 'state', version: state.version, changed }))
  store.onEvent((event) => live.broadcast({ type: 'event', event }))
  poller.scheduler.onChange(() => live.broadcast({ type: 'scan', scan: poller.scheduler.status() }))

  const app = express()
  app.disable('x-powered-by')
  app.set('etag', false)
  app.use(express.json({ limit: '4mb' }))
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store')
    next()
  })

  const api = express.Router()

  api.get('/health', (_req, res) => {
    const state = store.current()
    res.json({ ok: true, version: config.version, mode: config.mode, stateVersion: state.version, generatedAt: state.generatedAt, clients: live.size })
  })

  api.get('/state', (_req, res) => res.json(store.current()))
  api.get('/events', (_req, res) => {
    const state = store.current()
    live.subscribe(res, { type: 'hello', version: state.version, backend: state.backend })
  })
  api.get('/events/history', (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 200), store.settings.thresholds.eventHistory)
    res.json([...store.events].reverse().slice(0, limit))
  })

  api.get('/scan/status', (_req, res) => res.json(poller.scheduler.status()))
  api.post('/scan/request', (req, res) => {
    const { scope } = scopeSchema.parse(req.body ?? {})
    const queued = poller.request(scope as ScanScope)
    res.json({ queued, status: poller.scheduler.status() })
  })

  api.get('/summary', (_req, res) => res.json(store.current().summary))
  api.get('/infra', (_req, res) => res.json(store.current().infra))
  api.get('/devices', (_req, res) => res.json(store.current().devices))
  api.get('/devices/:id', (req, res) => {
    const device = store.current().devices.find((item) => item.id === req.params.id)
    if (!device) return res.status(404).json({ error: 'device not found' })
    res.json(device)
  })
  api.put('/devices/:id/meta', (req, res) => {
    const id = String(req.params.id)
    const patch = knownSchema.parse(req.body ?? {})
    const existing = store.known.get(id)
    const macs = new Set<string>()
    for (const raw of patch.macs) {
      const mac = normalizeMac(raw)
      if (mac) macs.add(mac)
    }
    if (id.startsWith('mac:')) macs.add(id.slice(4))
    const ips = new Set(patch.ips.map((ip) => ip.trim()).filter(Boolean))
    if (id.startsWith('ip:')) ips.add(id.slice(3))
    // A MAC can only belong to one device; steal it from any other known device.
    for (const other of store.known.values()) {
      if (other.id === id) continue
      const remaining = other.macs.filter((mac) => !macs.has(mac))
      if (remaining.length !== other.macs.length) store.upsertKnown({ ...other, macs: remaining, updatedAt: new Date().toISOString() })
    }
    const meta: KnownDeviceMeta = {
      id,
      displayName: patch.displayName.trim(),
      owner: patch.owner.trim(),
      category: patch.category.trim(),
      notes: patch.notes,
      favorite: patch.favorite,
      ignored: patch.ignored,
      macs: [...macs].sort(),
      ips: [...ips].sort(),
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    store.upsertKnown(meta)
    store.save(true)
    store.publish()
    res.json(meta)
  })
  api.delete('/devices/:id/meta', (req, res) => {
    store.deleteKnown(String(req.params.id))
    store.save(true)
    store.publish()
    res.json({ ok: true })
  })
  api.get('/known', (_req, res) => res.json([...store.known.values()]))

  // Setup: which planned infrastructure is part of this show.
  api.put('/infra/:id/use', (req, res) => {
    const id = String(req.params.id)
    if (!store.inventory.devices.some((device) => device.id === id)) return res.status(404).json({ error: 'device not found' })
    const { inUse } = z.object({ inUse: z.boolean() }).parse(req.body ?? {})
    store.setInUse(id, inUse, 'manual')
    if (inUse) poller.scheduler.request((jobId) => jobId.endsWith(`:${id}`))
    store.save(true)
    store.publish()
    res.json({ ok: true, inUse })
  })
  api.post('/setup/reset', (_req, res) => {
    store.resetSetup()
    store.save(true)
    store.publish()
    res.json({ ok: true })
  })

  api.get('/switches', (_req, res) => res.json(store.current().switches))
  api.get('/switches/:id', (req, res) => {
    const sw = store.current().switches.find((item) => item.id === req.params.id)
    if (!sw) return res.status(404).json({ error: 'switch not found' })
    res.json(sw)
  })
  api.get('/vlans', (_req, res) => res.json(store.current().vlans))
  api.get('/topology', (_req, res) => res.json(store.current().topology))
  api.get('/wlan', (_req, res) => res.json(store.current().wlan))
  api.get('/traffic', (_req, res) => {
    const traffic = store.current().traffic
    res.json({ ...traffic, series: trafficHistory(store, traffic) })
  })
  api.get('/problems', (_req, res) => res.json(store.current().problems))
  api.post('/problems/:id/resolve', (req, res) => {
    const result = store.resolveProblem(String(req.params.id))
    if (!result.ok) return res.status(result.status).json({ error: result.error })
    store.save(true)
    res.json({ ok: true, message: result.message })
  })

  api.get('/settings', (_req, res) => res.json(maskSettings(store.settings)))
  api.put('/settings', (req, res) => {
    const merged = mergeSettings(store.settings, req.body)
    const next = unmaskSettings(settingsSchema.parse(merged), store.settings)
    store.settings = next
    saveSettings(next)
    ctx.onSettingsChanged()
    store.addEvent({ kind: 'system', severity: 'info', message: 'Settings updated', subject: null })
    store.publish()
    res.json(maskSettings(next))
  })

  api.get('/inventory', (_req, res) =>
    res.json({
      projectName: store.inventory.projectName,
      updatedAt: store.inventory.updatedAt,
      source: store.inventory.source,
      vlans: store.inventory.vlans,
      subnets: store.inventory.subnets,
      devices: store.inventory.devices,
    }),
  )
  api.post('/inventory', (req, res) => {
    const file = resolve(config.dataDir, 'inventory.json')
    const inventory = parseInventory(req.body, file)
    writeJsonAtomic(file, req.body)
    store.inventory = inventory
    ctx.onInventoryChanged()
    store.addEvent({ kind: 'system', severity: 'info', message: `Inventory replaced: ${inventory.projectName} (${inventory.devices.length} devices)`, subject: null })
    store.publish()
    res.json({ ok: true, projectName: inventory.projectName, devices: inventory.devices.length })
  })
  api.post('/inventory/sync', async (_req, res, next) => {
    try {
      const file = resolve(config.dataDir, 'inventory.json')
      const remote = await fetchRemoteInventoryProject(store.settings.networkConfig)
      const inventory = parseInventory(remote.project, `${remote.sourceUrl}#revision=${remote.revision ?? 'unknown'}`)
      writeJsonAtomic(file, remote.project)
      store.inventory = inventory
      ctx.onInventoryChanged()
      const revision = remote.revision !== null ? ` revision ${remote.revision}` : ''
      store.addEvent({
        kind: 'system',
        severity: 'info',
        message: `Inventory resynced from network config${revision}: ${inventory.projectName} (${inventory.devices.length} devices)`,
        subject: null,
      })
      store.publish()
      const queued = poller.request('all')
      res.json({ ok: true, projectName: inventory.projectName, devices: inventory.devices.length, revision: remote.revision, queued })
    } catch (error) {
      if (error instanceof RemoteInventoryError) return res.status(error.status).json({ error: error.message })
      next(error)
    }
  })

  // On-site corrections without re-exporting the plan: patch a planned device's management IP.
  api.put('/inventory/devices/:id', (req, res) => {
    const id = String(req.params.id)
    const { managementIp } = z.object({ managementIp: z.string().trim().regex(/^(\d{1,3}\.){3}\d{1,3}$|^$/, 'not an IPv4 address') }).parse(req.body ?? {})
    const file = resolve(config.dataDir, 'inventory.json')
    const source = existsSync(file) ? file : config.inventoryFile
    const raw = JSON.parse(readFileSync(source, 'utf8')) as { devices?: { id: string; managementIp?: string }[] }
    const device = raw.devices?.find((item) => item.id === id)
    if (!device) return res.status(404).json({ error: 'device not found in inventory' })
    const previous = device.managementIp ?? ''
    device.managementIp = managementIp
    writeJsonAtomic(file, raw)
    store.inventory = parseInventory(raw, file)
    // Old reachability belongs to the old address.
    store.pings.delete(previous)
    ctx.onInventoryChanged()
    const name = store.inventory.devices.find((item) => item.id === id)?.name ?? id
    store.addEvent({ kind: 'system', severity: 'info', message: `${name}: management IP changed ${previous || '—'} → ${managementIp || '—'}`, subject: null })
    store.publish()
    poller.request('infra')
    res.json({ ok: true, managementIp })
  })

  api.get('/export', (_req, res) => {
    res.setHeader('Content-Disposition', `attachment; filename="aboutus-monitor-${new Date().toISOString().slice(0, 10)}.json"`)
    res.json({
      exportedAt: new Date().toISOString(),
      version: config.version,
      settings: store.settings,
      knownDevices: [...store.known.values()],
      inventorySource: store.inventory.source,
    })
  })
  api.post('/import', (req, res) => {
    const body = z
      .object({ settings: z.unknown().optional(), knownDevices: z.array(z.unknown()).optional() })
      .parse(req.body ?? {})
    let imported = { settings: false, knownDevices: 0 }
    if (body.settings) {
      store.settings = mergeSettings(store.settings, body.settings)
      saveSettings(store.settings)
      ctx.onSettingsChanged()
      imported.settings = true
    }
    for (const raw of body.knownDevices ?? []) {
      const parsed = knownSchema.extend({ id: z.string(), createdAt: z.string().optional(), updatedAt: z.string().optional() }).safeParse(raw)
      if (!parsed.success) continue
      store.upsertKnown({
        ...parsed.data,
        macs: parsed.data.macs.map((mac) => normalizeMac(mac)).filter((mac): mac is string => Boolean(mac)),
        createdAt: parsed.data.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      imported = { ...imported, knownDevices: imported.knownDevices + 1 }
    }
    store.save(true)
    store.addEvent({ kind: 'system', severity: 'info', message: `Import: ${imported.knownDevices} known devices${imported.settings ? ', settings' : ''}`, subject: null })
    store.publish()
    res.json({ ok: true, ...imported })
  })

  app.use('/api', api)
  app.use('/api', (_req, res) => res.status(404).json({ error: 'not found' }))

  // The built UI. During development Vite serves it and proxies /api here.
  if (existsSync(config.webDist)) {
    // Hashed bundles are immutable; index.html (and the few unhashed files) must always be revalidated,
    // otherwise a browser keeps pointing at an old bundle for an hour after every deploy.
    const noStore = (res: express.Response) => res.setHeader('Cache-Control', 'no-cache, must-revalidate')
    app.use(
      express.static(config.webDist, {
        index: false,
        etag: true,
        setHeaders: (res, path) => {
          if (path.includes(`${sep}assets${sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
          else noStore(res)
        },
      }),
    )
    app.get(/^(?!\/api\/).*/, (_req, res) => {
      noStore(res)
      res.sendFile(resolve(config.webDist, 'index.html'))
    })
  } else {
    app.get('/', (_req, res) =>
      res
        .status(200)
        .type('text')
        .send(`ABOUTUS network monitor backend is running (${config.mode}).\nThe web UI is not built yet: run "npm run build" in the project root.\nAPI: /api/state`),
    )
  }

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof z.ZodError) return res.status(400).json({ error: 'invalid request', issues: error.issues })
    const message = error instanceof Error ? error.message : String(error)
    logger.error(message)
    res.status(500).json({ error: message })
  })

  return { app, live }
}
