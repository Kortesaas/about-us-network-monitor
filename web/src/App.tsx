import { useEffect } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { AppShell } from '@/app/AppShell'
import { useMonitor } from '@/stores/monitorStore'
import { OverviewPage } from '@/pages/Overview'
import { DevicesPage } from '@/pages/Devices'
import { DevicePage } from '@/pages/Device'
import { TopologyPage } from '@/pages/Topology'
import { SwitchesPage } from '@/pages/Switches'
import { SwitchPage } from '@/pages/Switch'
import { VlansPage } from '@/pages/Vlans'
import { ProblemsPage } from '@/pages/Problems'
import { EventsPage } from '@/pages/Events'
import { SettingsPage } from '@/pages/Settings'

export function App() {
  const start = useMonitor((store) => store.start)
  useEffect(() => start(), [start])
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<Navigate to="/overview" replace />} />
        <Route path="/overview" element={<OverviewPage />} />
        <Route path="/devices" element={<DevicesPage />} />
        <Route path="/devices/:id" element={<DevicePage />} />
        <Route path="/topology" element={<TopologyPage />} />
        <Route path="/switches" element={<SwitchesPage />} />
        <Route path="/switches/:id" element={<SwitchPage />} />
        <Route path="/vlans" element={<VlansPage />} />
        <Route path="/problems" element={<ProblemsPage />} />
        <Route path="/events" element={<EventsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/overview" replace />} />
      </Routes>
    </AppShell>
  )
}
