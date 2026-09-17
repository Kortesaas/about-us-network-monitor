import { WifiOff } from 'lucide-react'
import { useMonitor } from '@/stores/monitorStore'
import { Button, EmptyState, Spinner } from '@/ui/kit'

/** Shown by every page until the first state arrives — or when the backend cannot be reached at all. */
export function LoadingState() {
  const { connection, error, reload } = useMonitor()
  if (connection === 'offline')
    return (
      <div className="p-6">
        <EmptyState
          icon={<WifiOff size={28} />}
          title="The monitor backend is not reachable"
          description={`The browser could not reach the Pi service at /api. ${error ?? ''} Check that the service is running (sudo systemctl status aboutus-net-monitor) and that you are on the same network.`}
          action={<Button onClick={() => void reload()}>Try again</Button>}
        />
      </div>
    )
  return (
    <div className="flex h-full min-h-[40vh] flex-col items-center justify-center gap-3 text-muted">
      <Spinner size={20} className="text-accent" />
      <p className="text-[13px]">Connecting to the Pi…</p>
    </div>
  )
}
