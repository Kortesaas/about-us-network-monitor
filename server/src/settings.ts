import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import type { Settings } from '@shared/types'
import { config } from './config.js'
import { log } from './logger.js'

const logger = log('settings')

const snmpTargetSchema = z.object({
  deviceId: z.string(),
  community: z.string(),
  version: z.enum(['1', '2c']).default('2c'),
  port: z.number().int().min(1).max(65535).default(161),
  enabled: z.boolean().default(true),
})

export const settingsSchema = z.object({
  polling: z
    .object({
      infraPingSeconds: z.number().int().min(5).max(3600).default(15),
      snmpFastSeconds: z.number().int().min(10).max(3600).default(30),
      snmpTablesSeconds: z.number().int().min(30).max(3600).default(120),
      snmpConfigSeconds: z.number().int().min(60).max(86400).default(300),
      routerArpSeconds: z.number().int().min(15).max(3600).default(60),
      neighborSeconds: z.number().int().min(5).max(3600).default(20),
      sweepSeconds: z.number().int().min(60).max(86400).default(180),
      snmpConcurrency: z.number().int().min(1).max(8).default(3),
      minGapSeconds: z.number().int().min(1).max(600).default(5),
      dnsSeconds: z.number().int().min(60).max(86400).default(600),
    })
    .default({}),
  thresholds: z
    .object({
      staleAfterSeconds: z.number().int().min(30).default(300),
      offlineAfterSeconds: z.number().int().min(60).default(900),
      relocationWindowSeconds: z.number().int().min(30).default(600),
      uplinkMacThreshold: z.number().int().min(2).default(6),
      portErrorsPerMinute: z.number().min(0).default(5),
      eventHistory: z.number().int().min(50).max(5000).default(500),
    })
    .default({}),
  discovery: z
    .object({
      sweepCidrs: z.array(z.string()).default([]),
      sweepEnabled: z.boolean().default(true),
      excludeCidrs: z.array(z.string()).default([]),
      reverseDns: z.boolean().default(true),
      routerArp: z.boolean().default(true),
      localNeighbors: z.boolean().default(true),
    })
    .default({}),
  snmp: z
    .object({
      timeoutMs: z.number().int().min(200).max(30000).default(2500),
      retries: z.number().int().min(0).max(5).default(1),
      targets: z.array(snmpTargetSchema).default([]),
      defaultCommunities: z.record(z.string()).default({
        lancom: 'aboutusrouter',
        dell: 'aboutusdell',
        'allied telesis': 'aboutusmon',
        'tp-link': 'aboutustplink',
      }),
    })
    .default({}),
  omada: z
    .object({
      enabled: z.boolean().default(false),
      baseUrl: z.string().default(''),
      omadacId: z.string().default(''),
      siteId: z.string().default(''),
      clientId: z.string().default(''),
      clientSecret: z.string().default(''),
      insecureTls: z.boolean().default(true),
      intervalSeconds: z.number().int().min(15).default(60),
    })
    .default({}),
  syslog: z
    .object({
      enabled: z.boolean().default(false),
      port: z.number().int().min(1).max(65535).default(5514),
    })
    .default({}),
  internet: z
    .object({
      enabled: z.boolean().default(true),
      targets: z.array(z.string()).default(['1.1.1.1', '8.8.8.8']),
      dnsCheckHost: z.string().default('cloudflare.com'),
      intervalSeconds: z.number().int().min(10).max(3600).default(30),
    })
    .default({}),
  ui: z.object({ showMacOnly: z.boolean().default(false) }).default({}),
})

export const defaultSettings = (): Settings => settingsSchema.parse({})

const settingsFile = () => resolve(config.dataDir, 'settings.json')

export function loadSettings(): Settings {
  const file = settingsFile()
  if (!existsSync(file)) return defaultSettings()
  try {
    const parsed = settingsSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')))
    if (parsed.success) return parsed.data
    logger.warn(`settings.json is invalid, using defaults: ${parsed.error.issues[0]?.message}`)
    return defaultSettings()
  } catch (error) {
    logger.warn('could not read settings.json, using defaults', error)
    return defaultSettings()
  }
}

/** Atomic write so a power cut mid-save never leaves a half file behind. */
export function writeJsonAtomic(file: string, value: unknown) {
  mkdirSync(resolve(file, '..'), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2))
  renameSync(tmp, file)
}

export function saveSettings(settings: Settings) {
  writeJsonAtomic(settingsFile(), settings)
}

/** Deep-merges a partial update and validates the result. */
export function mergeSettings(current: Settings, patch: unknown): Settings {
  const merged = deepMerge(current as unknown as Record<string, unknown>, patch as Record<string, unknown>)
  return settingsSchema.parse(merged)
}

function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return base
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    const existing = out[key]
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      existing &&
      typeof existing === 'object' &&
      !Array.isArray(existing)
    )
      out[key] = deepMerge(existing as Record<string, unknown>, value as Record<string, unknown>)
    else out[key] = value
  }
  return out
}

const SECRET = '••••••••'

/** Secrets never leave the Pi; the UI shows a placeholder and only overwrites when the user types. */
export function maskSettings(settings: Settings): Settings {
  return {
    ...settings,
    snmp: {
      ...settings.snmp,
      targets: settings.snmp.targets.map((target) => ({ ...target, community: target.community ? SECRET : '' })),
      defaultCommunities: Object.fromEntries(
        Object.entries(settings.snmp.defaultCommunities).map(([key, value]) => [key, value ? SECRET : '']),
      ),
    },
    omada: { ...settings.omada, clientSecret: settings.omada.clientSecret ? SECRET : '' },
  }
}

/** Puts masked placeholders back to their real values before saving. */
export function unmaskSettings(incoming: Settings, current: Settings): Settings {
  const targets = incoming.snmp.targets.map((target) => {
    if (target.community !== SECRET) return target
    const previous = current.snmp.targets.find((item) => item.deviceId === target.deviceId)
    return { ...target, community: previous?.community ?? '' }
  })
  const defaultCommunities = Object.fromEntries(
    Object.entries(incoming.snmp.defaultCommunities).map(([key, value]) => [
      key,
      value === SECRET ? (current.snmp.defaultCommunities[key] ?? '') : value,
    ]),
  )
  return {
    ...incoming,
    snmp: { ...incoming.snmp, targets, defaultCommunities },
    omada: {
      ...incoming.omada,
      clientSecret: incoming.omada.clientSecret === SECRET ? current.omada.clientSecret : incoming.omada.clientSecret,
    },
  }
}
