import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Background, Controls, Handle, MarkerType, MiniMap, Position, ReactFlow, useEdgesState, useNodesState, type Edge, type Node, type NodeProps } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import dagre from '@dagrejs/dagre'
import { Cable, Cpu, LayoutGrid, Router, Server, Wifi, HelpCircle, Share2 } from 'lucide-react'
import type { TopologyEdge, TopologyNode, VlanState } from '@shared/types'
import { Workspace } from '@/app/Page'
import { LoadingState } from '@/components/Loading'
import { ReachDot, VlanChip } from '@/components/status'
import { useMonitor } from '@/stores/monitorStore'
import { useThemeStore, isDarkTheme } from '@/stores/themeStore'
import { cn } from '@/ui/cn'
import { Badge, Button, EmptyState, SectionLabel, Toggle } from '@/ui/kit'
import { formatSpeed } from '@/utils/format'

type NodeData = { item: TopologyNode; vlans: VlanState[] } & Record<string, unknown>

const icons: Record<TopologyNode['kind'], typeof Server> = { switch: Cable, router: Router, 'access-point': Wifi, server: Server, computer: Cpu, media: Server, custom: Server, unknown: HelpCircle }

function DeviceNode({ data, selected }: NodeProps<Node<NodeData>>) {
  const { item } = data
  const Icon = icons[item.kind]
  const infra = item.kind !== 'unknown'
  const href = item.kind === 'switch' && item.planned ? `/switches/${item.id}` : infra ? '/overview' : `/devices/${encodeURIComponent(item.id)}`
  return (
    <div
      className={cn(
        'rounded-md border bg-surface px-2.5 py-2 text-left shadow-card transition-colors',
        infra ? 'min-w-[170px]' : 'min-w-[130px] opacity-90',
        selected ? 'border-accent' : item.reachability === 'offline' ? 'border-danger' : item.reachability === 'stale' ? 'border-warn' : 'border-line',
        (!item.planned && infra) || !item.inUse ? 'border-dashed' : '',
        !item.inUse && 'opacity-50',
      )}
    >
      <Handle type="target" position={Position.Top} className="!h-1.5 !w-1.5 !border-0 !bg-faint" />
      <Link to={href} className="block">
        <div className="flex items-center gap-2">
          <span className={cn('grid h-6 w-6 shrink-0 place-items-center rounded', item.reachability === 'online' ? 'bg-ok-soft text-ok' : item.reachability === 'offline' ? 'bg-danger-soft text-danger' : 'bg-surface-2 text-muted')}>
            <Icon size={13} />
          </span>
          <span className="min-w-0">
            <span className={cn('block truncate font-semibold text-ink', infra ? 'text-[12px]' : 'text-[11px]')}>{item.name}</span>
            <span className="block truncate text-[10px] text-faint">{item.subtitle || item.ip}</span>
          </span>
          <ReachDot value={item.reachability} className="ml-auto" />
        </div>
        {item.danglingTrunks.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {item.danglingTrunks.map((trunk) => (
              <span key={trunk.port} className={cn('rounded-sm px-1 text-[9px] font-semibold', trunk.up ? 'bg-warn-soft text-warn' : 'bg-surface-2 text-faint')} title={trunk.up ? 'Trunk is up but no LLDP neighbour was seen' : 'Planned trunk without link'}>
                {trunk.port} {trunk.name}
              </span>
            ))}
          </div>
        )}
      </Link>
      <Handle type="source" position={Position.Bottom} className="!h-1.5 !w-1.5 !border-0 !bg-faint" />
    </div>
  )
}

const nodeTypes = { device: DeviceNode }

function layout(nodes: TopologyNode[], edges: TopologyEdge[], showClients: boolean): { nodes: Node<NodeData>[]; edges: Edge[] } {
  const graph = new dagre.graphlib.Graph()
  graph.setGraph({ rankdir: 'TB', nodesep: 30, ranksep: 70, marginx: 20, marginy: 20 })
  graph.setDefaultEdgeLabel(() => ({}))
  const visibleNodes = nodes.filter((node) => showClients || node.kind !== 'unknown' || edges.some((edge) => edge.origin === 'lldp' && (edge.source === node.id || edge.target === node.id)))
  const ids = new Set(visibleNodes.map((node) => node.id))
  const visibleEdges = edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target))
  for (const node of visibleNodes) graph.setNode(node.id, { width: node.kind === 'unknown' ? 150 : 190, height: node.danglingTrunks.length ? 66 : 46 })
  // Routers on top, clients at the bottom: bias the ranking through edge direction.
  for (const edge of visibleEdges) {
    const source = nodes.find((node) => node.id === edge.source)
    const target = nodes.find((node) => node.id === edge.target)
    const flip = source && target && rank(source.kind) > rank(target.kind)
    graph.setEdge(flip ? edge.target : edge.source, flip ? edge.source : edge.target)
  }
  // Disconnected infra still gets a place near the top.
  dagre.layout(graph)
  return {
    nodes: visibleNodes.map((node) => {
      const pos = graph.node(node.id)
      return { id: node.id, type: 'device', position: { x: pos.x - pos.width / 2, y: pos.y - pos.height / 2 }, data: { item: node, vlans: [] } }
    }),
    edges: visibleEdges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: 'smoothstep',
      animated: edge.origin === 'lldp' && edge.up,
      label: edge.origin === 'lldp' ? `${edge.sourcePort ?? '?'} ↔ ${edge.targetPort ?? '?'}${edge.speedMbps ? ` · ${formatSpeed(edge.speedMbps)}` : ''}` : edge.sourcePort ? `port ${edge.sourcePort}` : undefined,
      labelStyle: { fontSize: 10, fill: 'var(--text-muted)' },
      labelBgStyle: { fill: 'var(--surface)', fillOpacity: 0.9 },
      labelBgPadding: [4, 2],
      style: {
        stroke: edge.warnings.length ? 'var(--warn)' : !edge.up ? 'var(--danger)' : edge.origin === 'client' ? '#3b465c' : 'var(--accent)',
        strokeWidth: edge.origin === 'client' ? 1 : 2,
        strokeDasharray: edge.origin === 'client' ? '3 3' : undefined,
      },
      markerEnd: edge.origin === 'client' ? undefined : { type: MarkerType.Arrow, color: edge.warnings.length ? 'var(--warn)' : 'var(--accent)' },
    })),
  }
}

const rank = (kind: TopologyNode['kind']) => ({ router: 0, switch: 1, 'access-point': 2, server: 3, computer: 3, media: 3, custom: 3, unknown: 4 })[kind]

export function TopologyPage() {
  const state = useMonitor((store) => store.state)
  const theme = useThemeStore((store) => store.theme)
  const [showClients, setShowClients] = useState(false)
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null)
  const computed = useMemo(() => (state ? layout(state.topology.nodes, state.topology.edges, showClients) : { nodes: [], edges: [] }), [state, showClients])
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<NodeData>>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const [autoLayout, setAutoLayout] = useState(true)

  useEffect(() => {
    // Keep manual drags between updates: only positions of nodes the user has not touched are refreshed.
    setNodes((current) => {
      const byId = new Map(current.map((node) => [node.id, node]))
      return computed.nodes.map((node) => {
        const existing = byId.get(node.id)
        return existing && !autoLayout ? { ...node, position: existing.position } : node
      })
    })
    setEdges(computed.edges)
  }, [computed, autoLayout, setNodes, setEdges])

  if (!state) return <LoadingState />
  const lldpEdges = state.topology.edges.filter((edge) => edge.origin === 'lldp')
  const selected = state.topology.edges.find((edge) => edge.id === selectedEdge) ?? null
  const dark = isDarkTheme(theme)

  if (state.topology.nodes.length === 0)
    return (
      <div className="p-6">
        <EmptyState icon={<Share2 size={24} />} title="No topology yet" description="Infrastructure from the inventory appears here; links are discovered over LLDP once the switches answer SNMP." />
      </div>
    )

  return (
    <Workspace
      toolbar={
        <>
          <span className="text-[12px] text-muted">
            {lldpEdges.length} LLDP link{lldpEdges.length === 1 ? '' : 's'} · {state.topology.nodes.filter((node) => node.kind !== 'unknown').length} infrastructure nodes
          </span>
          <div className="ml-auto flex items-center gap-2">
            <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-muted">
              <input type="checkbox" checked={showClients} onChange={(event) => setShowClients(event.target.checked)} className="accent-[var(--accent)]" />
              show located devices
            </label>
            <Button
              size="sm"
              onClick={() => {
                setAutoLayout(true)
                setNodes(computed.nodes)
              }}
            >
              <LayoutGrid size={12} /> Auto layout
            </Button>
          </div>
        </>
      }
      right={
        <div className="space-y-4 p-3">
          {selected ? (
            <div>
              <SectionLabel>Link</SectionLabel>
              <p className="text-[13px] font-semibold text-ink">
                {nameOf(state.topology.nodes, selected.source)} port {selected.sourcePort ?? '?'} ↔ {nameOf(state.topology.nodes, selected.target)} {selected.targetPort !== null ? `port ${selected.targetPort}` : ''}
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Badge tone={selected.up ? 'ok' : 'danger'}>{selected.up ? 'up' : 'down'}</Badge>
                {selected.speedMbps && <Badge>{formatSpeed(selected.speedMbps)}</Badge>}
                <Badge tone="accent">{selected.origin === 'lldp' ? 'LLDP' : selected.origin}</Badge>
              </div>
              {selected.vlanIds.length > 0 && (
                <div className="mt-3">
                  <SectionLabel>VLANs on this link</SectionLabel>
                  <div className="flex flex-wrap gap-1">
                    {[...new Set(selected.vlanIds)].sort((a, b) => a - b).map((vlan) => (
                      <VlanChip key={vlan} vlanId={vlan} vlans={state.vlans} />
                    ))}
                  </div>
                </div>
              )}
              {selected.warnings.length > 0 && (
                <ul className="mt-3 space-y-1 rounded bg-warn-soft p-2 text-[12px] text-warn">
                  {selected.warnings.map((warning) => (
                    <li key={warning}>• {warning}</li>
                  ))}
                </ul>
              )}
              {selected.sourcePort && (
                <Link to={`/switches/${selected.source}?port=${selected.sourcePort}`} className="mt-3 block text-[12px] text-accent-text hover:underline">
                  Open port {selected.sourcePort} on {nameOf(state.topology.nodes, selected.source)}
                </Link>
              )}
            </div>
          ) : (
            <div>
              <SectionLabel>Live topology</SectionLabel>
              <p className="text-[12px] leading-5 text-muted">Blue = LLDP link, amber = config differences, red = down. Dimmed nodes are planned but not in use. Click a link for VLANs and speed.</p>
            </div>
          )}
          <div>
            <SectionLabel>Expected but missing</SectionLabel>
            {state.topology.nodes.flatMap((node) => node.danglingTrunks.map((trunk) => ({ node, trunk }))).length === 0 ? (
              <p className="text-[12px] text-faint">Every planned trunk has an LLDP neighbour.</p>
            ) : (
              <ul className="space-y-1 text-[12px]">
                {state.topology.nodes.flatMap((node) => node.danglingTrunks.map((trunk) => ({ node, trunk }))).map(({ node, trunk }) => (
                  <li key={`${node.id}-${trunk.port}`} className="flex items-center gap-2">
                    <span className={cn('h-1.5 w-1.5 rounded-full', trunk.up ? 'bg-warn' : 'bg-faint')} />
                    <Link to={`/switches/${node.id}?port=${trunk.port}`} className="text-ink hover:text-accent-text hover:underline">
                      {node.name} · {trunk.port} {trunk.name}
                    </Link>
                    <span className="text-faint">{trunk.up ? 'up, no LLDP' : 'no link'}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <Toggle checked={!autoLayout} onChange={(value) => setAutoLayout(!value)} label="Keep my node positions" hint="Off: the graph re-arranges when the topology changes." />
        </div>
      }
    >
      <div className="h-full min-h-[420px]">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={(changes) => {
            if (changes.some((change) => change.type === 'position' && change.dragging)) setAutoLayout(false)
            onNodesChange(changes)
          }}
          onEdgesChange={onEdgesChange}
          onEdgeClick={(_event, edge) => setSelectedEdge(edge.id)}
          onPaneClick={() => setSelectedEdge(null)}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          minZoom={0.3}
          maxZoom={2}
          colorMode={dark ? 'dark' : 'light'}
          proOptions={{ hideAttribution: true }}
          nodesConnectable={false}
        >
          <Background gap={24} size={1} />
          <Controls showInteractive={false} />
          <MiniMap className="!hidden md:!block" pannable zoomable nodeColor={() => (dark ? '#323c51' : '#c3ccda')} maskColor={dark ? 'rgba(6,9,17,0.7)' : 'rgba(244,246,249,0.7)'} />
        </ReactFlow>
      </div>
    </Workspace>
  )
}

const nameOf = (nodes: TopologyNode[], id: string) => nodes.find((node) => node.id === id)?.name ?? id
