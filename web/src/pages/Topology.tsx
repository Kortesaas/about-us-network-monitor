import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Background, BaseEdge, Controls, EdgeLabelRenderer, Handle, MarkerType, MiniMap, Position, ReactFlow, getSmoothStepPath, useEdgesState, useNodesState, type Edge, type EdgeProps, type Node, type NodeProps } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import dagre from '@dagrejs/dagre'
import { Cable, Cpu, Globe, LayoutGrid, Router, Server, Wifi, HelpCircle, Share2 } from 'lucide-react'
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

const icons: Record<TopologyNode['kind'], typeof Server> = { internet: Globe, switch: Cable, router: Router, 'access-point': Wifi, server: Server, computer: Cpu, media: Server, custom: Server, unknown: HelpCircle }

function DeviceNode({ data, selected }: NodeProps<Node<NodeData>>) {
  const { item } = data
  const Icon = icons[item.kind]
  const infra = item.kind !== 'unknown'
  const href = item.kind === 'internet' ? '/traffic' : item.kind === 'switch' && item.planned ? `/switches/${item.id}` : infra ? '/overview' : `/devices/${encodeURIComponent(item.id)}`
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

type RoutedData = { text: string | null; tone: 'accent' | 'warn' | 'danger' | 'client' } & Record<string, unknown>

const edgeText = (edge: TopologyEdge, flipped: boolean) => {
  if (edge.origin === 'lldp') {
    const [a, b] = flipped ? [edge.targetPort, edge.sourcePort] : [edge.sourcePort, edge.targetPort]
    return `${a ?? '?'} ↔ ${b ?? '?'}${edge.speedMbps ? ` · ${formatSpeed(edge.speedMbps)}` : ''}`
  }
  if (edge.origin === 'client') return null
  if (edge.origin === 'wan') return null
  if (edge.sourcePort) return `port ${edge.sourcePort}`
  return edge.sourcePortName ? `port ${edge.sourcePortName}` : 'via'
}

/**
 * Layered layout (dagre / network simplex): routers on top, switches, then APs and
 * endpoints. Edge labels are given a size so dagre keeps rank gaps wide enough for
 * them; the edges themselves are plain step paths between the placed nodes.
 */
function layout(nodes: TopologyNode[], edges: TopologyEdge[], showClients: boolean): { nodes: Node<NodeData>[]; edges: Edge<RoutedData>[] } {
  const graph = new dagre.graphlib.Graph({ multigraph: true })
  graph.setGraph({ rankdir: 'TB', nodesep: 48, ranksep: 64, edgesep: 24, marginx: 20, marginy: 20, ranker: 'network-simplex' })
  graph.setDefaultEdgeLabel(() => ({}))
  const visibleNodes = nodes.filter((node) => showClients || node.kind !== 'unknown' || edges.some((edge) => edge.origin === 'lldp' && (edge.source === node.id || edge.target === node.id)))
  const ids = new Set(visibleNodes.map((node) => node.id))
  const visibleEdges = edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target))
  const byId = new Map(nodes.map((node) => [node.id, node]))
  // Stable order in → stable layout out; dagre keeps the insertion order as its initial ordering.
  for (const node of [...visibleNodes].sort((a, b) => rank(a.kind) - rank(b.kind) || a.name.localeCompare(b.name)))
    graph.setNode(node.id, { width: node.kind === 'unknown' ? 150 : 190, height: node.danglingTrunks.length ? 66 : 46 })
  // Edges always point down the hierarchy so routers end up on top and clients at the bottom.
  const flipped = new Map<string, boolean>()
  for (const edge of visibleEdges) {
    const flip = rank(byId.get(edge.source)?.kind ?? 'unknown') > rank(byId.get(edge.target)?.kind ?? 'unknown')
    flipped.set(edge.id, flip)
    const text = edgeText(edge, flip)
    graph.setEdge(flip ? edge.target : edge.source, flip ? edge.source : edge.target, text ? { width: text.length * 5.6 + 12, height: 18, labelpos: 'c' } : { width: 1, height: 1 }, edge.id)
  }
  dagre.layout(graph)
  return {
    nodes: visibleNodes.map((node) => {
      const pos = graph.node(node.id)
      return { id: node.id, type: 'device', position: { x: pos.x - pos.width / 2, y: pos.y - pos.height / 2 }, data: { item: node, vlans: [] } }
    }),
    edges: visibleEdges.map((edge) => {
      const flip = flipped.get(edge.id) ?? false
      const tone: RoutedData['tone'] = !edge.up ? 'danger' : edge.warnings.length ? 'warn' : edge.origin === 'client' ? 'client' : 'accent'
      const stroke = tone === 'warn' ? 'var(--warn)' : tone === 'danger' ? 'var(--danger)' : tone === 'client' ? 'var(--line-strong)' : 'var(--accent)'
      return {
        id: edge.id,
        // Drawn top → down; the inspector still shows the original direction.
        source: flip ? edge.target : edge.source,
        target: flip ? edge.source : edge.target,
        type: 'routed',
        // Every live link flows; client placements and down links stay still.
        animated: edge.up && edge.origin !== 'client',
        data: { text: edgeText(edge, flip), tone },
        style: {
          stroke,
          strokeWidth: edge.origin === 'client' ? 1 : edge.origin === 'fdb' ? 1.5 : 2,
          strokeDasharray: edge.origin === 'client' || edge.origin === 'fdb' ? '4 3' : undefined,
        },
        markerEnd: edge.origin === 'client' ? undefined : { type: MarkerType.Arrow, color: stroke },
      }
    }),
  }
}

/** Step edge (down, across at the midpoint, down) with the label on the crossbar — dagre only places the nodes. */
function RoutedEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, style, markerEnd, selected }: EdgeProps<Edge<RoutedData>>) {
  const [path, labelX, labelY] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 10 })
  const text = data?.text ?? null
  const tone = data?.tone ?? 'accent'
  return (
    <>
      <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} interactionWidth={16} />
      {text && (
        <EdgeLabelRenderer>
          <div
            className={cn(
              'nodrag nopan pointer-events-auto absolute rounded border px-1.5 py-px text-[10px] font-medium leading-4',
              selected ? 'border-accent bg-accent-soft text-accent-text' : tone === 'warn' ? 'border-warn/50 bg-surface text-warn' : tone === 'danger' ? 'border-danger/50 bg-surface text-danger' : 'border-line bg-surface text-muted',
            )}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {text}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

const edgeTypes = { routed: RoutedEdge }

const rank = (kind: TopologyNode['kind']) => ({ internet: -1, router: 0, switch: 1, 'access-point': 2, server: 3, computer: 3, media: 3, custom: 3, unknown: 4 })[kind]

export function TopologyPage() {
  const state = useMonitor((store) => store.state)
  const theme = useThemeStore((store) => store.theme)
  const [showClients, setShowClients] = useState(false)
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null)
  const computed = useMemo(() => (state ? layout(state.topology.nodes, state.topology.edges, showClients) : { nodes: [], edges: [] }), [state, showClients])
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<NodeData>>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge<RoutedData>>([])
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
    // Routed points only make sense at the computed positions; hand-moved graphs get plain step edges.
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
                <Badge tone="accent">{originLabel(selected.origin)}</Badge>
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
              <p className="text-[12px] leading-5 text-muted">Blue = live infrastructure link, dashed = MAC-table location, amber = config differences, red = down. Disabled current-show components are hidden.</p>
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
          edgeTypes={edgeTypes}
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

const originLabel = (origin: TopologyEdge['origin']) => {
  if (origin === 'lldp') return 'LLDP'
  if (origin === 'fdb') return 'MAC table'
  if (origin === 'wan') return 'WAN uplink'
  return origin
}
