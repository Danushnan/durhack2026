import { connectionPurpose, recentConnections, TRAFFIC_WINDOW_SECONDS } from './discoveryActivity'
import { discoveryReady, roadKey, type RoadDiscovery } from './roadDiscovery'
import type { ClusterState, Edge } from './k8s'

function Measurements({edge}: {edge: Edge}) {
  const purpose = connectionPurpose(edge)
  const http = purpose.kind === 'HTTP'
  return <div className="discovery-measurements">
    <span>{edge.requests} {http ? 'HTTP calls' : 'observed operations'} / {TRAFFIC_WINDOW_SECONDS}s · {edge.rps.toFixed(2)}/s</span>
    <span>{edge.latency_ms == null ? 'Timed duration unavailable' : `Avg timed ${http ? 'call' : 'operation'}: ${edge.latency_ms.toFixed(1)} ms`}</span>
    <span>{edge.error_rate === undefined ? 'Reply errors unavailable' : `${(edge.error_rate*100).toFixed(1)}% non-success/error replies`}
      {edge.refused_rate !== undefined && ` · ${(edge.refused_rate*100).toFixed(1)}% failed communication`}</span>
  </div>
}

export function DiscoveryActivity({cluster, discovery, selectedKey, onPick, onClear, onInspect, onJourney}: {
  cluster: ClusterState; discovery: RoadDiscovery; selectedKey: string | null
  onPick: (edge: Edge) => void; onClear: () => void; onInspect: (service: string) => void; onJourney: () => void
}) {
  const ready = discoveryReady(cluster)
  const rows = recentConnections(cluster,discovery)
  const selected = selectedKey && discovery.roads.has(selectedKey) ? selectedKey.split('>') : null
  const selectedEdge = ready ? cluster.edges.find(edge => roadKey(edge) === selectedKey) : undefined
  const selectedPurpose = selected ? connectionPurpose({from:selected[0],to:selected[1]}) : null
  return <aside className="hud discovery-activity" aria-label="Discovery recent activity">
    <h2>Recent Activity</h2>
    <p className="discovery-guidance">Cars illustrate recent aggregate communication, not individual requests. Their speed and movement are visual animations; cars can finish a trip after its measured window becomes idle.</p>
    <p className="small muted">Buildings = services and data stores. Roads = known or observed dependencies. More activity means a busier connection; cars are sampled to keep the view calm.</p>
    <button className="discovery-journey-link" onClick={onJourney}>Follow one shopping action in Journey →</button>
    <p className="small muted">Journey follows an explicitly identified click. This list uses the rolling {TRAFFIC_WINDOW_SECONDS}-second TRAFFIC window, busiest first; it has no event chronology.</p>
    <div className="discovery-activity-list">
      {!ready ? <p role="status">Live activity unavailable or incomplete. Waiting for fresh telemetry.</p>
        : !discovery.armed ? <p role="status">Discovery is arming for a fresh window. Shop normally while it prepares.</p>
        : !rows.length ? <p role="status">No measured activity on discovered connections in the current window. Add to Basket or browse MiniShop to explore.</p>
        : <ul>{rows.map(edge => {
          const key = roadKey(edge), purpose = connectionPurpose(edge)
          return <li key={key}><button className="discovery-connection" aria-pressed={key === selectedKey} onClick={() => onPick(edge)}>
            <b>{purpose.source} → {purpose.destination}</b><span className="discovery-kind">{purpose.kind}</span>
            <span>Typical purpose: {purpose.description}</span><Measurements edge={edge} />
          </button></li>
        })}</ul>}
    </div>
    {selected && selectedPurpose && <section className="discovery-selection" aria-label="Selected connection">
      <div className="discovery-selection-title"><b>{selectedPurpose.source} → {selectedPurpose.destination}</b><button className="small" onClick={onClear}>Clear highlight</button></div>
      {!ready ? <p className="small muted">Current activity unavailable; highlighting the known relationship only.</p>
        : !selectedEdge || !Number.isSafeInteger(selectedEdge.requests) ? <p className="small muted">No current measurement is available for this relationship.</p> : selectedEdge.requests === 0 && selectedEdge.rps === 0 ? <p className="small muted">Idle in the current window. The discovered dependency stays in place.</p> : <Measurements edge={selectedEdge} />}
      <p className="small">Typical purpose: {selectedPurpose.description}</p>
      <div className="discovery-inspect"><button onClick={() => onInspect(selected[0])}>Inspect {selectedPurpose.source}</button><button onClick={() => onInspect(selected[1])}>Inspect {selectedPurpose.destination}</button></div>
      <p className="small muted">The cyan lane follows this logical relationship; other relationships can share its physical roads.</p>
    </section>}
    <p className="small muted">Descriptions explain typical purpose. Aggregate edges do not identify a particular operation, request, shopper or payload. Counts describe instrumented completions, not SQL statement counts. Timed averages use available samples; Checkout’s broad transaction wrapper is excluded.</p>
    {(cluster.demoPackets && Object.keys(cluster.demoPackets.routes).length > 0) && <p className="small muted">Admin map-preview roads and vehicles are explicit illustrations, not measured dependencies. They are excluded from this list.</p>}
  </aside>
}
