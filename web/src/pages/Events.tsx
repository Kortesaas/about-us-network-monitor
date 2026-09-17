import { useMemo, useState } from 'react'
import { Activity } from 'lucide-react'
import type { EventKind } from '@shared/types'
import { Page } from '@/app/Page'
import { LoadingState } from '@/components/Loading'
import { EventRow } from '@/components/EventRow'
import { useMonitor } from '@/stores/monitorStore'
import { EmptyState, Input, Panel, Segmented } from '@/ui/kit'

type Group = 'all' | 'devices' | 'ports' | 'infra' | 'problems' | 'system'
const groups: Record<Exclude<Group, 'all'>, EventKind[]> = {
  devices: ['device-online', 'device-offline', 'device-new', 'device-moved'],
  ports: ['port-up', 'port-down'],
  infra: ['infra-online', 'infra-offline', 'syslog'],
  problems: ['problem-raised', 'problem-cleared'],
  system: ['scan', 'system'],
}

export function EventsPage() {
  const state = useMonitor((store) => store.state)
  const [group, setGroup] = useState<Group>('all')
  const [query, setQuery] = useState('')
  const rows = useMemo(() => {
    const events = state?.events ?? []
    const kinds = group === 'all' ? null : new Set(groups[group])
    const q = query.trim().toLowerCase()
    return events.filter((event) => (!kinds || kinds.has(event.kind)) && (!q || event.message.toLowerCase().includes(q)))
  }, [state, group, query])
  if (!state) return <LoadingState />
  const byDay = new Map<string, typeof rows>()
  for (const event of rows) {
    const day = new Date(event.at).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })
    byDay.set(day, [...(byDay.get(day) ?? []), event])
  }
  return (
    <Page
      title="Events"
      description="What changed and when."
      actions={
        <>
          <Segmented
            value={group}
            onChange={setGroup}
            options={[
              { value: 'all', label: 'All' },
              { value: 'devices', label: 'Devices' },
              { value: 'ports', label: 'Ports' },
              { value: 'infra', label: 'Infra' },
              { value: 'problems', label: 'Problems' },
              { value: 'system', label: 'System' },
            ]}
          />
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter…" className="w-40" aria-label="Filter events" />
        </>
      }
    >
      {rows.length === 0 ? (
        <Panel>
          <EmptyState icon={<Activity size={24} />} title="No events" description="Events appear as soon as something changes on the network." />
        </Panel>
      ) : (
        <div className="space-y-4">
          {[...byDay.entries()].map(([day, events]) => (
            <Panel key={day} title={day} bodyClassName="p-1.5">
              {events.map((event) => (
                <EventRow key={event.id} event={event} />
              ))}
            </Panel>
          ))}
        </div>
      )}
    </Page>
  )
}
