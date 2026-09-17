# HTTP API

All endpoints live under `/api`, return JSON and are unauthenticated (the
monitor is read-mostly and lives on the closed show network). Types are in
`shared/types.ts`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Liveness: version, mode, state version, connected browsers |
| GET | `/api/state` | The complete `MonitorState` (summary, infra, switches, devices, vlans, topology, problems, events, scan, backend) |
| GET | `/api/events` | Server-Sent Events: `hello`, `state` (new version + changed keys), `scan` (job status), `event` (timeline entry), `ping` |
| GET | `/api/events/history?limit=200` | Event timeline |
| GET | `/api/scan/status` | Scheduler jobs with last run, duration, next due, errors |
| POST | `/api/scan/request` `{ scope }` | Queue jobs now: `all`, `infra`, `switches`, `sweep`, `neighbors`, `switch:<id>`; cooldowns still apply |
| GET | `/api/summary` · `/api/infra` · `/api/devices` · `/api/devices/:id` · `/api/switches` · `/api/switches/:id` · `/api/vlans` · `/api/topology` · `/api/problems` | Slices of the state |
| PUT | `/api/devices/:id/meta` | Create/update known-device metadata (`displayName`, `owner`, `category`, `notes`, `favorite`, `ignored`, `macs[]`, `ips[]`). A MAC belongs to one device; adding it here removes it from any other. |
| DELETE | `/api/devices/:id/meta` | Remove metadata |
| GET | `/api/known` | All known-device metadata |
| PUT | `/api/infra/:id/use` `{ inUse }` | Mark a planned device as part of / not part of the current setup (manual, never overridden automatically) |
| POST | `/api/setup/reset` | New show: forget auto-added devices and learned trunk links |
| GET | `/api/settings` | Settings with secrets masked as `••••••••` |
| PUT | `/api/settings` | Deep-merge a partial settings object; masked secrets are kept; polling is reconfigured live |
| GET | `/api/inventory` | Parsed plan |
| POST | `/api/inventory` | Replace the plan with a planner export (stored in `DATA_DIR/inventory.json`) |
| GET | `/api/export` | Backup file: settings (unmasked), known devices |
| POST | `/api/import` | Restore a backup (`settings`, `knownDevices[]`) |

Validation errors return `400 { error: "invalid request", issues: [...] }`.
