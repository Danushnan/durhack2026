import { JourneyPanel, useJourney } from './Journey'
import { useEffect, useRef, useState } from 'react'
import { City, type HoverInfo, type RoadFlow, type ServiceState, type ViewMode } from './City'
import { affected, describeFlow, ERROR_RATE, overview, serviceFlow, SIGNAL, type Signal, signalOf, SLOW_MS } from './health'
import {
  ACTION_FAILED, api, type ClusterState, deploymentHealth, describeDeployment, describePod, FRIENDLY, HEALTH_COLOR, isWorkload, type K8sObject, keyOf, NODE_COLORS,
  nodeReady, podsOf, type PodStatus, podStatus, rolloutOf, versionColor, STATUS_COLOR, useCluster,
} from './k8s'
import { landmarkFor } from './landmarks'
import { COMPONENTS, componentOf, downServices, explain, impactChain, kubectl, nameOf, roleOf } from './teach'
import { THEMES, useThemeMode } from './theme'
import { routeKey, Telemetry, useTelemetry } from './Telemetry'
import { liveServiceView } from './liveMetrics'
import { LiveIncidentBanner, LiveOverview, LiveServiceDetails, LiveSourceStatus } from './LiveMonitoring'
import type { LiveServiceView } from './liveMetrics'
import { discoveryReady, type RoadDiscovery, startDiscovery, updateDiscovery } from './roadDiscovery'
import { DEMO_DEPOT } from './demoPackets'
import { districtOf } from './streetNetwork'

const DISTRICT_COLORS = ['#22d3ee', '#e879f9', '#bef264', '#fbc08c', '#93a9ff', '#fba6c8']

export default function App() {
  const cluster = useCluster()
  const [selected, setSelected] = useState<string | null>(null)
  const [powerGrid, setPowerGrid] = useState(false)
  const [hover, setHover] = useState<HoverInfo | null>(null)
  const [help, setHelp] = useState(false)
  const [sidebar, setSidebar] = useState(false)
  const [feedOpen, setFeedOpen] = useState(false)
  const [homeTick, setHomeTick] = useState(0)
  const [analyticsOpen, setAnalyticsOpen] = useState(false)
  const [replayAt, setReplayAt] = useState<number | null>(null)
  const simulatorSource = cluster.context === null
  const telemetry = useTelemetry(replayAt, simulatorSource)
  const services = telemetry.status === 'ready' ? Object.fromEntries(telemetry.services.map((row) => [row.service, row])) : {}
  const routes = telemetry.status === 'ready' ? Object.fromEntries(telemetry.routes.map((row) => [routeKey(row.caller, row.service), row])) : {}
  const [toast, setToast] = useState<string | null>(null)
  const source = cluster.metrics?.source_id ?? cluster.context
  const journey = useJourney(cluster.metrics?.source_id)
  const previousSource = useRef(source)
  useEffect(() => {
    if (previousSource.current !== undefined && previousSource.current !== source) {
      setSelected(null); setReplayAt(null); setAnalyticsOpen(false)
    }
    previousSource.current = source
  }, [source])
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const show = (e: Event) => { setToast((e as CustomEvent<string>).detail); clearTimeout(timer); timer = setTimeout(() => setToast(null), 6000) }
    window.addEventListener(ACTION_FAILED, show)
    return () => { window.removeEventListener(ACTION_FAILED, show); clearTimeout(timer) }
  }, [])
  const [mode, setMode] = useThemeMode()
  const theme = THEMES[mode]
  const [view, setView] = useState<ViewMode>(() => { try { return localStorage.getItem('kubeverse.view') === '3d' ? '3d' : 'iso' } catch { return 'iso' } })
  useEffect(() => { try { localStorage.setItem('kubeverse.view', view) } catch { /* per-viewer nicety only */ } }, [view])
  const [legendOpen, setLegendOpen] = useState(false)

  const all = Object.values(cluster.objects)
  const nodes = all.filter((o) => o.kind === 'Node').sort((a, b) => a.metadata.name.localeCompare(b.metadata.name))
  const miniShopKeys = new Set(cluster.metrics?.services.map((row) => row.service))
  const deployments = all.filter(isWorkload).sort((a, b) => Number(!miniShopKeys.has(keyOf(a))) - Number(!miniShopKeys.has(keyOf(b))) || keyOf(a).localeCompare(keyOf(b)))
  const districts = [...new Set(deployments.flatMap(({ metadata }) => metadata.namespace ? [metadata.namespace] : []))].sort()
  if (Object.values(cluster.demoPackets?.routes ?? {}).some(({ call }) => call.from === DEMO_DEPOT || call.to === DEMO_DEPOT)) {
    const depot = districtOf(DEMO_DEPOT)
    if (!districts.includes(depot)) districts.push(depot)
  }
  const districtColors = new Map(districts.map((name, i) => [name, DISTRICT_COLORS[i % DISTRICT_COLORS.length]]))
  const events = all.filter((o) => o.kind === 'Event').sort((a, b) =>
    Number(b.metadata.uid.slice(3)) - Number(a.metadata.uid.slice(3)))
  const dep = deployments.find((o) => keyOf(o) === selected)
  const node = selected?.startsWith('node:') ? nodes.find((n) => n.metadata.name === selected.slice(5)) : undefined
  const sim = cluster.connected && simulatorSource && !cluster.awaitingSnapshot
  const rush = all.some((o) => o.kind === 'Ingress' && o.status?.['kubeverse.io/rush-hour'])

  // Traffic for each request route. With TigerData, its measured rows win (and are all there is during replay).
  const flows: RoadFlow[] = cluster.edges.map((e) => {
    const m = routes[routeKey(e.from, e.to)]
    return m ? { ...e, rps: m.rps, latency_ms: m.latency_ms, measured: true,
      error_rate: e.healthy ? m.error_rate : 0, refused_rate: e.healthy ? 0 : Math.max(m.error_rate, 0.5) } : e
  })
  const down = downServices(deployments)
  const states: ServiceState = Object.fromEntries(deployments.map((d) => {
    const k = keyOf(d)
    const live = liveServiceView(d, cluster)
    if (live) return [k, { live, down: live.infrastructure === 'unavailable' || live.infrastructure === 'scaled_down',
      chain: null, flow: serviceFlow(k, []), affected: live.affected }]
    const chain = down.has(k) ? null : impactChain(k, cluster.edges, down)
    const flow = serviceFlow(k, flows)
    if (flow.signal === 'ok' && services[k]?.anomaly) flow.signal = 'slow' // TigerData: far slower than its own baseline
    const ready = d.status?.readyReplicas ?? 0, want = d.spec?.replicas ?? 0
    return [k, { down: down.has(k), chain, flow, affected: affected({ ready, want, signal: flow.signal, basis: flow.basis, impactedBy: chain ? nameOf(chain[chain.length - 1]) : null }) }]
  }))
  const unhealthyPods = all.some((o) => o.kind === 'Pod' && podStatus(o) !== 'Running')
  const outages = nodes.filter((n) => !nodeReady(n))
  const live = typeof cluster.context === 'string'
  const [discovery, setDiscovery] = useState<RoadDiscovery | null>(null)
  useEffect(() => { setDiscovery((current) => {
    const updated = updateDiscovery(current, cluster)
    if (updated) return updated
    return cluster.metrics?.services.some(({ deployment_uid }) => deployment_uid && cluster.objects[deployment_uid])
      ? startDiscovery(cluster.metrics.source_id, Date.now()) : null
  }) }, [cluster])
  const activeDiscovery = discovery?.source === cluster.metrics?.source_id ? discovery : null
  const miniShopSource = activeDiscovery?.source ??
    (cluster.metrics?.services.some(({ deployment_uid }) => deployment_uid && cluster.objects[deployment_uid])
      ? cluster.metrics.source_id : undefined)
  const beginDiscovery = () => {
    if (miniShopSource) setDiscovery(startDiscovery(miniShopSource, Date.now()))
    setHover(null)
  }
  const liveViews = Object.fromEntries(Object.entries(states).flatMap(([key, s]) => s.live ? [[key, s.live]] : [])) as Record<string, LiveServiceView>

  return (
    <div className={`app ${mode}`}>
      <City cluster={cluster} selected={selected} onSelect={setSelected} powerGrid={powerGrid} theme={theme}
        onHover={setHover} states={states} homeTick={homeTick} flows={flows} districtColors={districtColors} replay={simulatorSource && replayAt !== null} mode={view}
        journeyActive={journey.enabled && !!miniShopSource}
        journeyPlaybackKey={`${journey.journey?.action_id}:${journey.step}:${journey.replayTick}`}
        journeyServices={journey.enabled && journey.journey?.state !== 'ambiguous' ? journey.journey?.steps.flatMap(step => [step.from_service, step.to_service].filter((key): key is string => !!key)) : undefined}
        journeyStep={journey.enabled && journey.journey && journey.journey.source === miniShopSource && journey.journey.state !== 'ambiguous' ? journey.journey.steps[journey.step] : undefined}
        discoveredRoads={activeDiscovery?.roads}
        trafficPaused={live && (!cluster.connected || !!cluster.awaitingSnapshot || !!cluster.stale || !!cluster.metricsStale ||
          !!cluster.metricsError || (!!activeDiscovery && !discoveryReady(cluster)))} />

      <header className="hud brand">
        <h1>Kuebec <small>Port Kube</small></h1>
        <span className={`dot ${cluster.connected ? 'on' : ''}`} title={cluster.connected ? 'WebSocket connected; source health shown separately' : 'WebSocket reconnecting…'}
          aria-label={cluster.connected ? 'WebSocket connected' : 'WebSocket reconnecting'} />
        {cluster.context && <span className="badge" title="Watching a real Kubernetes cluster through kubectl. Simulator controls are hidden.">
          live cluster · {cluster.context} · read-only{cluster.stale ? ' · ⚠ data may be stale' : ''}</span>}
        {simulatorSource && <span className="badge">Simulator · {replayAt === null ? 'simulated activity' : 'historical simulated activity'}</span>}
        {live && <LiveSourceStatus cluster={cluster} />}
      </header>

      <nav className="hud controls" aria-label="View controls">
        <button aria-label="Reset the camera to the overview" title="Reset view"
          onClick={() => { setSelected(null); setHomeTick(homeTick + 1) }}>⌂</button>
        <button aria-label={view === 'iso' ? 'Switch to the free 3D view' : 'Switch to the isometric view'}
          title={view === 'iso' ? '3D view: drag to orbit, right-drag to pan' : 'Isometric view: drag to pan'}
          onClick={() => setView(view === 'iso' ? '3d' : 'iso')}>{view === 'iso' ? '3D' : 'ISO'}</button>
        <button aria-label={`Switch to ${mode === 'night' ? 'day' : 'night'}`} title="Day / night"
          onClick={() => setMode(mode === 'night' ? 'day' : 'night')}>{mode === 'night' ? '🌙' : '☀️'}</button>
        <button aria-pressed={powerGrid} className={powerGrid ? 'on' : ''} title="Power Grid: colour each Unit by the Node it runs on"
          onClick={() => setPowerGrid(!powerGrid)}>⚡</button>
        {sim && <button aria-pressed={rush} className={rush ? 'on' : ''} aria-label={rush ? 'End rush hour' : 'Start rush hour'}
          title="Rush hour: triple the customers at the City Gate and watch the autoscaler react" onClick={() => api.rushHour(!rush)}>🚦</button>}
        {sim && <button aria-label="Reset the city to its starting state" title="Reset city"
          onClick={() => { if (window.confirm('Reset Port Kube to its starting state? Every change you made will be undone.')) { setSelected(null); api.reset() } }}>⟲</button>}
        <button aria-expanded={legendOpen} className={legendOpen ? 'on' : ''} title="Legend: what every colour means" aria-label="Legend"
          onClick={() => setLegendOpen(!legendOpen)}>◧</button>
        <button aria-expanded={help} className={help ? 'on' : ''} title="How this city works" onClick={() => setHelp(!help)}>?</button>
        {simulatorSource && <button aria-expanded={analyticsOpen} className={analyticsOpen ? 'on' : ''} title="Network analytics · simulated TigerData history"
          aria-label="Network analytics" onClick={() => {
            if (analyticsOpen) setReplayAt(null)
            setAnalyticsOpen(!analyticsOpen)
          }}>▥</button>}
      </nav>

      {miniShopSource && <section className="hud discovery-controls" aria-label="MiniShop roads">
        <button type="button" aria-pressed={!!activeDiscovery} onClick={() => { if (!activeDiscovery) beginDiscovery() }}>Discovery</button>
        {activeDiscovery && <>
          <button type="button" onClick={beginDiscovery}>Reset Discovery</button>
          <span role="status">
            {activeDiscovery.roads.size} routes discovered
            {!discoveryReady(cluster) ? ' · Waiting for live telemetry'
              : !activeDiscovery.armed ? ' · Arming for a fresh window' : ' · Ready to observe'}
          </span>
        </>}
      </section>}

      {miniShopSource && <section className="hud journey-controls" aria-label="Activity view">
        <button aria-pressed={!journey.enabled} onClick={() => journey.setEnabled(false)}>Traffic</button>
        <button aria-pressed={journey.enabled} onClick={() => journey.setEnabled(true)}>Journey</button>
        {!journey.enabled && <span>Cars illustrate aggregate service activity.</span>}
      </section>}
      {miniShopSource && journey.enabled && <JourneyPanel controller={journey} />}

      {live ? <>
        <LiveIncidentBanner deployments={deployments} views={liveViews} onPick={setSelected} />
        <LiveOverview cluster={cluster} views={liveViews} onPick={setSelected} />
      </> : simulatorSource ? <>
        <Banner deployments={deployments} states={states} outages={outages} edges={flows} onPick={setSelected} />
        <Overview flows={flows} deployments={deployments} states={states} onPick={setSelected} />
      </> : <section className="hud overview" role="status">
        <b>{cluster.connected ? 'Loading cluster snapshot…' : 'Connecting to the cluster…'}</b>
        <p className="small muted">Waiting for the backend to identify the data source.</p>
      </section>}

      {help && <Help live={live} onClose={() => setHelp(false)} />}
      {analyticsOpen && simulatorSource && <Telemetry snapshot={telemetry} at={replayAt} onSeek={setReplayAt} onClose={() => {
        setReplayAt(null)
        setAnalyticsOpen(false)
      }} />}

      <aside className={`hud services ${sidebar ? 'open' : ''}`} aria-label="Services">
        <button className="toggle" aria-expanded={sidebar} title={sidebar ? 'Collapse' : 'Show service names'}
          onClick={() => setSidebar(!sidebar)}>{sidebar ? '‹' : '›'}</button>
        {deployments.map((d) => {
          const info = landmarkFor(d.metadata.name), k = keyOf(d), s = states[k]
          const color = s.live?.color ?? s.affected?.color ?? HEALTH_COLOR[deploymentHealth(d)]
          return (
            <button key={d.metadata.uid} className={`svc ${selected === k ? 'sel' : ''}`} onClick={() => setSelected(k)}
              title={`${info.title}: ${d.metadata.name}. ${roleOf(d.metadata.name).does}`} aria-label={`${d.metadata.name}, ${describeDeployment(d)}`}>
              <span className="emoji">{info.emoji}<i className="pip" style={{ background: color }} /></span>
              {sidebar && <span className="svc-text"><b>{d.metadata.name}</b><small>{s.live ? `${s.affected?.label ?? `Application ${s.live.application.replaceAll('_', ' ')}`} · ${s.live.availability}` : s.affected ? `${s.affected.icon} ${s.affected.label}` : describeDeployment(d)}</small></span>}
            </button>
          )
        })}
        <hr />
        <button className={`svc ${selected === 'city-hall' ? 'sel' : ''}`} onClick={() => setSelected('city-hall')}
          title="City Hall: the control plane" aria-label="City Hall, the control plane">
          <span className="emoji">🏛️</span>{sidebar && <span className="svc-text"><b>City Hall</b><small>control plane</small></span>}
        </button>
        {nodes.map((n, i) => {
          const ready = nodeReady(n)
          return (
            <button key={n.metadata.uid} className={`svc ${selected === `node:${n.metadata.name}` ? 'sel' : ''}`}
              onClick={() => setSelected(`node:${n.metadata.name}`)} aria-label={`Power Station ${n.metadata.name}`}>
              <span className="emoji">⚡<i className="pip" style={{ background: !ready ? '#ef4444' : n.spec?.unschedulable ? '#f59e0b' : NODE_COLORS[i % NODE_COLORS.length] }} /></span>
              {sidebar && <span className="svc-text"><b>{n.metadata.name}</b><small>{!ready ? 'Power cut' : n.spec?.unschedulable ? 'Maintenance' : 'Running'}</small></span>}
            </button>
          )
        })}
      </aside>

      {node && <StationPanel node={node} all={all} sim={sim} onClose={() => setSelected(null)} />}
      {selected === 'city-hall' && <HallPanel events={events} onClose={() => setSelected(null)} />}
      {dep && <Inspect dep={dep} cluster={cluster} all={all} events={events} states={states} edges={flows} sim={sim} onPick={setSelected} onClose={() => setSelected(null)} />}

      {legendOpen ? <Legend live={live} districtColors={districtColors} onClose={() => setLegendOpen(false)} /> : (powerGrid || unhealthyPods) && (
        <div className="hud legend" aria-label="Legend">
          {powerGrid
            ? nodes.map((n, i) => <span key={n.metadata.uid}><i style={{ background: NODE_COLORS[i % NODE_COLORS.length] }} />{n.metadata.name}</span>)
            : (Object.keys(STATUS_COLOR) as PodStatus[]).map((s) => <span key={s}><i style={{ background: STATUS_COLOR[s] }} />{FRIENDLY[s]}</span>)}
        </div>
      )}

      <aside className={`hud ticker ${feedOpen ? 'open' : ''}`} aria-live="polite">
        <button className="ticker-head" onClick={() => setFeedOpen(!feedOpen)} aria-expanded={feedOpen}>
          <span>🧠 Kubernetes</span>
          {events[0] ? <EventLine e={events[0]} /> : <span className="muted">watching…</span>}
          <span className="chev">{feedOpen ? '▾' : '▴'}</span>
        </button>
        {feedOpen && events.slice(0, 8).map((e) => <EventRow key={e.metadata.uid} e={e} />)}
      </aside>

      {toast && <div className="hud toast" role="alert"><b>⚠ Action failed.</b> {toast}<button className="close" aria-label="Dismiss" onClick={() => setToast(null)}>×</button></div>}

      {hover && (
        <div className="tooltip" style={{ left: hover.x + 14, top: hover.y + 14 }} role="tooltip">
          <b>{hover.title}</b>
          {hover.lines.map((l) => <div key={l}>{l}</div>)}
        </div>
      )}
    </div>
  )
}

/** Explains the knock-on effect of whatever is broken right now. */
function Banner({ deployments, states, outages, edges, onPick }: {
  deployments: K8sObject[]; states: ServiceState; outages: K8sObject[]; edges: RoadFlow[]; onPick: (k: string) => void
}) {
  const downDeps = deployments.filter((d) => states[keyOf(d)]?.down)
  // Failing requests while every Pod is fine: the app is broken, not Kubernetes.
  const bad = (k: string) => !states[k]?.down && !states[k]?.chain && (states[k]?.affected?.rank ?? 0) >= 4
  // Name the root cause first: a failing service whose own calls are fine, not the callers it drags down.
  const dragged = (k: string) => states[k]?.flow.basis === 'received' && deployments.some((y) => bad(keyOf(y)) && keyOf(y) !== k &&
    states[keyOf(y)].flow.basis === 'received' && edges.some((e) => e.from === k && e.to === keyOf(y)))
  const failing = deployments.filter((x) => bad(keyOf(x))).sort((a, b) => Number(dragged(keyOf(a))) - Number(dragged(keyOf(b))) ||
    states[keyOf(b)].affected!.rank - states[keyOf(a)].affected!.rank || Number(states[keyOf(a)].flow.basis === 'sent') - Number(states[keyOf(b)].flow.basis === 'sent'))
  if (!downDeps.length && !outages.length && failing.length) {
    const f = failing[0], st = states[keyOf(f)]
    return (
      <div className="hud banner" role="status">
        <b>{st.affected!.icon} {f.metadata.name}: {st.affected!.label.toLowerCase()}</b> ({describeFlow(st.flow)}).
        {' '}Its Pods are {f.status?.readyReplicas ?? 0}/{f.spec?.replicas} ready: the application is failing, not Kubernetes.
        {' '}<button className="link" onClick={() => onPick(keyOf(f))}>Inspect →</button>
        {failing.length > 1 && <span className="muted"> (+{failing.length - 1} more)</span>}
      </div>
    )
  }
  if (!downDeps.length && !outages.length) return null
  const d = downDeps[0]
  const affected = d ? deployments.filter((x) => states[keyOf(x)]?.chain?.includes(keyOf(d))) : []
  return (
    <div className="hud banner" role="status">
      {d ? (
        <>
          <b>💥 {d.metadata.name} is down.</b> {roleOf(d.metadata.name).ifDown}
          {affected.length > 0 && <> Knock-on effect: {affected.map((a, i) => (
            <span key={a.metadata.uid}>{i > 0 && ', '}<button className="link" onClick={() => onPick(keyOf(a))}>{a.metadata.name}</button></span>
          ))} {affected.length === 1 ? 'is' : 'are'} impacted.</>}
          {' '}<button className="link" onClick={() => onPick(keyOf(d))}>Inspect →</button>
          {downDeps.length > 1 && <span className="muted"> (+{downDeps.length - 1} more down)</span>}
        </>
      ) : (
        <><b>🔌 {outages.map((n) => n.metadata.name).join(', ')} lost power.</b> Kubernetes is moving its Pods to the remaining Nodes.</>
      )}
    </div>
  )
}

function Help({ live, onClose }: { live: boolean; onClose: () => void }) {
  return (
    <div className="hud help" role="dialog" aria-label="How this city works">
      <button className="close" onClick={onClose} aria-label="Close">×</button>
      <h2>How Port Kube works</h2>
      <p>Port Kube is a shop's software running on <b>Kubernetes</b>, drawn as a city. Drag to move around; scroll or pinch to zoom.
        Press <b>3D</b> to orbit freely (drag to turn, right-drag to move), <b>ISO</b> to go back.</p>
      <ul>
        <li>🏦 <b>Buildings</b> are services (Deployments). Each does one job: hover one to see what. A bigger Building means more copies were asked for.</li>
        <li>🏙️ Towers, houses and trees around the edge are just scenery.</li>
        <li>▪️ <b>Units</b> in front are its Pods: identical copies doing the work. ⬚ An outlined <b>Plot</b> is a Pod still being created.</li>
        <li>🛣️ Requests share <b>Roads</b> and drive through roundabouts. Lorries take the highway between districts. Edge lines show the most affected route on each street. Hover to see the individual calls, or open ◧ for the legend.</li>
        <li>💡 A Building glows with how its <b>requests</b> are going; its <b>Units</b> show its <b>Pods</b>. They are separate: every Pod can be ready while the app answers with errors.</li>
        <li>🚨 A pulsing ring (and a light beam when serious) marks every Building that needs attention; the overview at the bottom left lists them.</li>
        <li>🚗 <b>Cars</b> illustrate aggregate request activity. They are not individual traced requests or proof of which Pod served a request.</li>
        <li>⚡ <b>Power Stations</b> are Nodes: the machines Pods run on. Their lights show used Pod slots.</li>
        <li>🌐 The <b>City Gate</b> is an Ingress: customers from the internet enter there and go to the frontend.</li>
        <li>🏛️ <b>City Hall</b> is the control plane. Glowing <b>messengers</b> fly out for each decision; their colour says which part decided.</li>
        <li>🛢️ {live ? 'MiniShop uses PostgreSQL and Redis Deployments with persistent volumes; HTTP metrics do not apply to those stores.' : <><b>Storage tanks</b> beside the Archive are its volumes: this simulated database is a <b>StatefulSet</b>, so its data outlives its Pods.</>}</li>
        <li>🚗 <span className="amber">Orange</span> illustrates HTTP response errors, including business rejections; <span className="red">red</span> illustrates calls with no HTTP answer. Neither proves a root cause.</li>
        <li>🎨 A Unit's cap colour is its <b>version</b> when supplied by the source. Pod flashes illustrate distribution across Ready units.</li>
      </ul>
      <h3>How Kubernetes thinks</h3>
      <p>You tell Kubernetes the <b>desired state</b> ("3 copies of the frontend"). A control loop constantly compares it with
        the <b>actual state</b> and fixes any difference: replacing crashed Pods, moving Pods off failed Nodes, adding or removing copies.</p>
      {live ? <p>Live Kubernetes is read-only here. Use MiniShop and its existing demo scripts to generate activity and controlled incidents. Buildings show backend application health; Pods show infrastructure readiness. Dependency highlights indicate connections and potential impact, not confirmed failures.</p> : <><h3>Try it</h3>
      <ul>
        <li>Open a Building and <b>Demolish</b> a Unit: watch a replacement appear.</li>
        <li><b>Release</b> a new version of the Bank and watch caps change colour one Unit at a time; release a <b>buggy</b> one and see the rollout stall while the old version keeps serving, then <b>Roll back</b>.</li>
        <li><b>Sabotage</b> the Bank: every copy crashes, payments go down and checkout becomes <span className="amber">impacted</span>.</li>
        <li>Click a <b>Power Station</b>: compare planned <b>maintenance</b> (Units move out gently, respecting budgets) with a sudden <b>power cut</b>.</li>
        <li>Press <b>🚦</b> for rush hour: customers triple, the autoscaler adds frontend Units, roads fill up, and later it scales back down.</li>
        <li><b>⟲</b> puts the city back to how it started.</li>
      </ul></>}
    </div>
  )
}

function EventLine({ e }: { e: K8sObject }) {
  return <span className={`event-line ${e.type === 'Warning' ? 'bad' : ''}`}><b>{e.reason}</b> {e.involvedObject?.name}: {explain(e) || e.message}</span>
}

function EventRow({ e }: { e: K8sObject }) {
  const why = explain(e)
  return (
    <div className={`event ${e.type === 'Warning' ? 'bad' : ''}`}>
      <div><b>{e.reason}</b> {e.involvedObject?.name}: <span className="msg">{e.message}</span></div>
      {why && <div className="why">↳ {why}</div>}
    </div>
  )
}

function Action({ label, hint, cmd, onClick, bad, disabled }: {
  label: string; hint: string; cmd: string; onClick: () => void; bad?: boolean; disabled?: boolean
}) {
  return (
    <button className={`action ${bad ? 'bad' : ''}`} onClick={onClick} disabled={disabled} title={cmd}>
      {label}<small>{hint}</small><code>{cmd}</code>
    </button>
  )
}

/** Desired state vs actual state, and what the control loop is doing about the difference. */
function DesiredActual({ dep, pods }: { dep: K8sObject; pods: K8sObject[] }) {
  const r = rolloutOf(dep, pods)
  const want: number = dep.spec.replicas
  const ready = dep.status?.readyReplicas ?? 0
  const versions = Object.entries(r.byVersion).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
  const old = versions.filter(([v]) => v !== r.version)
  const doing = r.stalled
    ? { cls: 'warn', text: `Stuck: ${r.version} Pods never became ready, so Kubernetes stopped the rollout and kept the old version serving. Roll back, or release a fix.` }
    : old.length
      ? { cls: 'warn', text: `Rolling out ${r.version}: it adds a ${r.version} Pod, waits for it to be ready, then removes an old one, never dropping below ${want - Math.floor(want / 4)} ready.` }
      : ready < want
        ? { cls: 'warn', text: `Fixing: ${want - ready} more ${want - ready === 1 ? 'Pod needs' : 'Pods need'} to start and become ready.` }
        : pods.filter((p) => !p.metadata.deletionTimestamp).length > want
          ? { cls: 'warn', text: 'Fixing: stopping extra Pods.' }
          : { cls: 'ok', text: 'In sync ✓ Actual matches desired, so there is nothing to do.' }
  return (
    <div className="desired">
      <div><span>Desired</span><b>{want} × {r.version}{r.buggy ? ' 🐞' : ''}</b></div>
      <div><span>Actual</span><b>{versions.length ? versions.map(([v, n]) => (
        <span key={v} className="ver"><i style={{ background: versionColor(v) }} />{v}: {n.ready}/{n.total} ready</span>
      )) : 'no Pods'}</b></div>
      <p className={`now ${doing.cls}`}>{doing.text}</p>
    </div>
  )
}

function Inspect({ dep, cluster, all, events, states, edges, sim, onPick, onClose }: {
  dep: K8sObject; cluster: ClusterState; all: K8sObject[]; events: K8sObject[]; states: ServiceState
  edges: RoadFlow[]; sim: boolean; onPick: (k: string) => void; onClose: () => void
}) {
  const ns = dep.metadata.namespace!, name = dep.metadata.name, key = keyOf(dep)
  const info = landmarkFor(name), role = roleOf(name), state = states[key]
  const pods = podsOf(dep, all.filter((o) => o.kind === 'Pod'))
    .sort((a, b) => (a.metadata.creationTimestamp ?? '').localeCompare(b.metadata.creationTimestamp ?? ''))
  const stateful = dep.kind === 'StatefulSet'
  const hpa = all.find((o) => o.kind === 'HorizontalPodAutoscaler' && o.metadata.namespace === ns && o.spec.scaleTargetRef.name === name)
  const claims = all.filter((o) => o.kind === 'PersistentVolumeClaim' && o.metadata.namespace === ns && o.metadata.labels?.app === name)
  const pdb = all.find((o) => o.kind === 'PodDisruptionBudget' && o.metadata.namespace === ns && o.metadata.name === name)
  const replicaSets = all.filter((o) => o.kind === 'ReplicaSet' && o.metadata.namespace === ns &&
    o.metadata.ownerReferences?.[0]?.uid === dep.metadata.uid)
    .sort((a, b) => a.metadata.name.localeCompare(b.metadata.name))
  const mine = events.filter((e) => e.involvedObject?.namespace === ns &&
    (e.involvedObject.name === name || e.involvedObject.name.startsWith(`${name}-`))).slice(0, 6)
  const sabotaged = dep.metadata.annotations?.['kubeverse.io/sabotaged'] === 'true'
  const replicas: number = dep.spec.replicas
  const dependsOn = edges.filter((e) => e.from === key).map((e) => e.to)
  const usedBy = edges.filter((e) => e.to === key).map((e) => e.from)
  const chip = (k: string) => k.startsWith('ingress:')
    ? <span key={k} className="chip">🌐 City Gate (customers)</span>
    : (
      <button key={k} className={`chip ${states[k]?.down ? 'bad' : states[k]?.chain ? 'warn' : ''}`} onClick={() => onPick(k)}>
        {landmarkFor(nameOf(k)).emoji} {nameOf(k)}
      </button>
    )
  const r = rolloutOf(dep, pods)
  const next = `v${Number((dep.metadata.annotations?.['kubeverse.io/latest-version'] ?? r.version).slice(1)) + 1}`
  const endpoints = pods.filter((p) => !p.metadata.deletionTimestamp && p.status?.containerStatuses?.[0]?.ready).length
  const podsNow = state?.down
    ? { cls: 'bad', text: `Pods: 💥 none ready. ${role.ifDown}` }
    : { cls: deploymentHealth(dep) === 'healthy' ? 'ok' : 'warn', text: `Pods: ${describeDeployment(dep)}` }
  const flow = state?.flow, signal = flow ? SIGNAL[flow.signal] : null
  const requestsNow = state?.chain && !state.down
    ? { cls: 'warn', text: `Requests: ⚠ impacted. It is running, but ${state.chain.map(nameOf).join(' → ')} ${state.chain.length > 1 ? 'chain is' : 'is'} down, so requests that need it fail.` }
    : flow && signal ? { cls: flow.signal === 'ok' ? 'ok' : flow.signal === 'idle' ? '' : flow.signal === 'slow' ? 'warn' : 'bad',
      text: `Requests ${flow.basis}: ${signal.icon} ${signal.label}. ${flow.rps > 0 ? describeFlow(flow) : 'none right now.'}` } : null

  return (
    <aside className="hud inspect" aria-label={`${name} details`}>
      <button className="close" onClick={onClose} aria-label="Close">×</button>
      <h2>{info.emoji} {info.title} <small>{name} · {ns}</small></h2>
      <p className="does">{role.does}</p>
      {state?.live ? <LiveServiceDetails view={state.live} cluster={cluster} dep={dep} /> : <>
        <p className={`now ${podsNow.cls}`}>{podsNow.text}</p>
        {requestsNow && <p className={`now ${requestsNow.cls}`}>{requestsNow.text}</p>}
      </>}
      <dl className="facts">
        <dt>If it stops</dt><dd>{role.ifDown}</dd>
        {dependsOn.length > 0 && <><dt>Needs</dt><dd>{dependsOn.map(chip)}</dd></>}
        {usedBy.length > 0 && <><dt>Used by</dt><dd>{usedBy.map(chip)}</dd></>}
      </dl>
      {state?.live && <>
        <p className="muted small">Connections describe dependencies. A connected service is only potentially affected until its own measurements show degradation. Road response errors include 4xx and 5xx; application health above uses the separate backend classification.</p>
        <FlowTable title="Outgoing dependency activity · 5s" rows={edges.filter((e) => e.from === key)} end="to" onPick={onPick} />
        <FlowTable title="Incoming dependency activity · 5s" rows={edges.filter((e) => e.to === key)} end="from" onPick={onPick} />
      </>}
      {flow && !state?.live && <>
        <h3>Requests <small>· separate from Pod health</small></h3>
        <Tiles items={[
          { label: `req/s ${flow.basis}`, value: flow.rps < 10 ? flow.rps.toFixed(1) : String(Math.round(flow.rps)) },
          { label: 'avg latency', value: flow.latency_ms == null ? '—' : `${Math.round(flow.latency_ms)} ms`, status: flow.rps > 0 && (flow.latency_ms ?? 0) >= SLOW_MS ? 'slow' : undefined },
          { label: 'answered with error', value: pct(flow.error_rate ?? 0), status: (flow.error_rate ?? 0) >= ERROR_RATE ? 'errors' : undefined },
          { label: 'refused', value: pct(flow.refused_rate ?? 0), status: (flow.refused_rate ?? 0) > 0 ? 'refused' : undefined },
        ]} />
        <FlowTable title="Calls it makes" rows={edges.filter((e) => e.from === key)} end="to" onPick={onPick} />
        <FlowTable title="Called by" rows={edges.filter((e) => e.to === key)} end="from" onPick={onPick} />
      </>}
      <h3>Desired vs actual</h3>
      {state?.live ? <p className="endpoints">Kubernetes resource snapshot: {dep.spec?.replicas ?? '—'} desired replicas · {dep.status?.readyReplicas ?? 0} Ready. Pod details below describe the last resource observation.</p>
        : <DesiredActual dep={dep} pods={pods} />}
      {hpa && (
        <div className="note">
          <b>📈 Autoscaled</b> (HorizontalPodAutoscaler): {hpa.status.currentMetrics[0].pods.current.averageValue} requests/s per ready Unit,
          target {hpa.spec.metrics[0].pods.target.averageValue}. Keeps between {hpa.spec.minReplicas} and {hpa.spec.maxReplicas} Units
          and wants {hpa.status.desiredReplicas} now. Try 🚦 rush hour. <code>{kubectl.hpa(ns, name)}</code>
        </div>
      )}
      {stateful && (
        <div className="note">
          <b>🗄️ StatefulSet</b>: its Units are numbered ({name}-0, {name}-1…), start one at a time in order, and each keeps its own
          storage tank ({claims.map((c) => c.metadata.name).join(', ') || 'none yet'}). Demolish one and the same name comes back with the same data.
          It is never run twice at once, so on a failed Power Station it waits instead of being copied elsewhere.
        </div>
      )}
      {pdb && <p className="endpoints">Disruption budget: at most <b>{pdb.spec.maxUnavailable}</b> Unit may be taken away on purpose (e.g. by maintenance) at a time.</p>}
      {replicaSets.length > 0 && <p className="endpoints">ReplicaSets (one per version; old ones are kept for roll back): {replicaSets.map((rs, i) => (
        <span key={rs.metadata.uid}>{i > 0 && ' · '}<code>{rs.metadata.name}</code> {rs.metadata.labels?.version} {rs.status?.readyReplicas ?? 0}/{rs.spec?.replicas}</span>
      ))}</p>}
      <p className="endpoints">Service <code>{name}</code> sends requests to <b>{endpoints} of {pods.filter((p) => !p.metadata.deletionTimestamp).length}</b> Units: only ready ones are in rotation.</p>
      {sim ? <>
        <h3>Try it <small>· each button is a kubectl command</small></h3>
        <div className="actions">
          <Action label="➕ Add Unit" hint={hpa ? 'The autoscaler owns this count' : 'Desired +1: Kubernetes creates a Pod'} disabled={replicas >= 10 || !!hpa}
            cmd={kubectl.scale(ns, name, replicas + 1)} onClick={() => api.scale(ns, name, replicas + 1)} />
          <Action label="➖ Remove Unit" hint={hpa ? 'It would undo a manual change' : 'Desired −1: Kubernetes stops one'} disabled={replicas <= 0 || !!hpa}
            cmd={kubectl.scale(ns, name, replicas - 1)} onClick={() => api.scale(ns, name, replicas - 1)} />
          {!stateful && <>
            <Action label={`🚀 Release ${next}`} hint="A working new version, rolled out gradually"
              cmd={kubectl.release(ns, name, next)} onClick={() => api.release(ns, name, false)} />
            <Action bad label={`🐞 Release buggy ${next}`} hint="It crashes: watch the rollout stall safely"
              cmd={kubectl.release(ns, name, next)} onClick={() => api.release(ns, name, true)} />
            <Action label={`↩ Roll back${r.previous ? ` to ${r.previous}` : ''}`} hint="Return to the previous version" disabled={!r.previous}
              cmd={kubectl.rollback(ns, name)} onClick={() => api.rollback(ns, name)} />
          </>}
          {sabotaged
            ? <Action label="🔧 Repair" hint="Next restart succeeds" cmd="(simulation only)" onClick={() => api.sabotage(ns, name, false)} />
            : <Action bad label="💣 Sabotage" hint="Every copy crashes, old and new alike" cmd="(simulation only)" onClick={() => api.sabotage(ns, name, true)} />}
        </div>
        {stateful && <p className="endpoints muted">StatefulSets update one numbered Pod at a time in reverse order; releases are not simulated for them here.</p>}
      </> : <p className="endpoints muted">Watching a real cluster: read-only.</p>}
      <h3>Units <small>(Pods) · {dep.status?.readyReplicas ?? 0} of {replicas} ready</small></h3>
      <table>
        <tbody>
          {pods.map((p) => {
            const s = podStatus(p)
            return (
              <tr key={p.metadata.uid}>
                <td><i style={{ background: STATUS_COLOR[s] }} />{p.metadata.name}<small><i style={{ background: versionColor(p.metadata.labels?.version ?? 'v1') }} />{p.metadata.labels?.version ?? (sim ? 'v1' : 'version unavailable')}</small></td>
                <td>{describePod(p)}<small>{s}</small></td>
                <td title="Restarts">↻ {p.status?.containerStatuses?.[0]?.restartCount ?? 0}</td>
                <td title="Node (Power Station)">{p.spec.nodeName ?? '—'}</td>
                <td>{sim && s !== 'Terminating' && (
                  <button className="bad small" title={`${kubectl.demolish(ns, p.metadata.name)}: delete this Pod and watch Kubernetes replace it`}
                    onClick={() => api.demolish(ns, p.metadata.name)}>Demolish</button>
                )}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <h3>What Kubernetes did</h3>
      {mine.map((e) => <EventRow key={e.metadata.uid} e={e} />)}
    </aside>
  )
}

/** A Power Station (Node): its Pods, and the two very different ways of taking it away. */
function StationPanel({ node, all, sim, onClose }: { node: K8sObject; all: K8sObject[]; sim: boolean; onClose: () => void }) {
  const name = node.metadata.name
  const ready = nodeReady(node)
  const cordoned = !!node.spec?.unschedulable
  const drain: string = node.metadata.annotations?.['kubeverse.io/drain'] ?? ''
  const pods = all.filter((o) => o.kind === 'Pod' && o.spec?.nodeName === name)
  const capacity = Number(node.status?.capacity?.pods ?? 0)
  const cut = node.metadata.annotations?.['kubeverse.io/power-cut'] === 'true'
  const state = !ready ? { cls: 'bad', text: '🔌 Power cut: no heartbeats, so Kubernetes marked the Node NotReady and tainted it. Its Pods left rotation, then were evicted: they stay Terminating until it returns; Deployments start replacements elsewhere, the StatefulSet waits.' }
    : cut ? { cls: 'bad', text: '🔌 Power cut, but Kubernetes has not noticed yet: the control plane only knows a Node is gone when its heartbeats stop arriving.' }
    : cordoned ? { cls: 'warn', text: drain.startsWith('blocked') ? `🚧 Maintenance, waiting: ${drain.slice(9)}. Kubernetes waits for a replacement to be ready elsewhere first.`
      : drain === 'draining' ? '🚧 Maintenance: moving its Units elsewhere, respecting each service\'s disruption budget.'
        : '🚧 Maintenance: drained and cordoned. No new Pods will be placed here until it is uncordoned.' }
      : { cls: 'ok', text: `Running ${pods.filter((p) => !p.metadata.deletionTimestamp).length} of ${capacity} Pod slots.` }
  return (
    <aside className="hud inspect" aria-label={`Power Station ${name}`}>
      <button className="close" onClick={onClose} aria-label="Close">×</button>
      <h2>⚡ Power Station <small>{name} · a Node</small></h2>
      <p className="does">A machine that runs Pods. Its kubelet (the agent on the machine) starts and stops their containers.</p>
      <p className={`now ${state.cls}`}>{state.text}</p>
      {sim && <>
        <h3>Try it</h3>
        <div className="actions two">
          {cordoned
            ? <Action label="✅ End maintenance" hint="Uncordon: new Pods may come here again" cmd={kubectl.uncordon(name)} onClick={() => api.drain(name, false)} />
            : <Action label="🚧 Maintenance" hint="Planned: cordon, then move Units out gently" cmd={kubectl.drain(name)} onClick={() => api.drain(name, true)} disabled={!ready} />}
          {!cut
            ? <Action bad label="🔌 Cut power" hint="Unplanned: the machine just dies" cmd="(simulation only)" onClick={() => api.outage(name, true)} />
            : <Action label="⚡ Restore power" hint="The Node comes back and reports in" cmd="(simulation only)" onClick={() => api.outage(name, false)} />}
        </div>
      </>}
      <h3>Units on this station <small>· {pods.length}</small></h3>
      <table>
        <tbody>
          {pods.map((p) => {
            const st = podStatus(p)
            return (
              <tr key={p.metadata.uid}>
                <td><i style={{ background: STATUS_COLOR[st] }} />{p.metadata.name}</td>
                <td>{describePod(p)}<small>{st}</small></td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </aside>
  )
}

/** City Hall: the control plane, its parts, and the decisions it made most recently. */
function HallPanel({ events, onClose }: { events: K8sObject[]; onClose: () => void }) {
  return (
    <aside className="hud inspect" aria-label="City Hall">
      <button className="close" onClick={onClose} aria-label="Close">×</button>
      <h2>🏛️ City Hall <small>the control plane</small></h2>
      <p className="does">Nothing here runs your app. It decides. The API server keeps the city's records (in etcd); the parts below
        keep comparing what you asked for with what exists, and send orders to fix the difference. Each glowing messenger is one decision.</p>
      <h3>Who sends which messenger</h3>
      <ul className="components">
        {Object.entries(COMPONENTS).map(([id, c]) => (
          <li key={id}><i style={{ background: c.color }} /><b>{c.label}</b> {c.does}</li>
        ))}
      </ul>
      <h3>Latest decisions</h3>
      {events.filter((e) => COMPONENTS[componentOf(e)]).slice(0, 8).map((e) => (
        <div key={e.metadata.uid} className="event"><i style={{ background: COMPONENTS[componentOf(e)].color }} />
          <b>{e.reason}</b> {e.involvedObject?.name}: {explain(e) || e.message}</div>
      ))}
    </aside>
  )
}

const pct = (r: number) => `${(r * 100).toFixed(r > 0 && r < 0.1 ? 1 : 0)}%`

/** Headline numbers. A status value carries an icon and a label, never colour alone. */
function Tiles({ items }: { items: { label: string; value: string; status?: Signal }[] }) {
  return (
    <div className="tiles">
      {items.map((t) => (
        <div key={t.label} className="tile" style={t.status ? { borderColor: SIGNAL[t.status].color } : undefined}>
          <b>{t.value}</b>
          <span>{t.status && <i style={{ background: SIGNAL[t.status].color }} aria-hidden />}{t.status ? `${SIGNAL[t.status].icon} ` : ''}{t.label}</span>
        </div>
      ))}
    </div>
  )
}

/** One row per request route in or out of a service. */
function FlowTable({ title, rows, end, onPick }: { title: string; rows: RoadFlow[]; end: 'from' | 'to'; onPick: (k: string) => void }) {
  if (!rows.length) return null
  return <>
    <h3>{title}</h3>
    <table className="flows"><tbody>
      {rows.map((e) => {
        const other = e[end], sig = SIGNAL[signalOf(e)], gate = other.startsWith('ingress:')
        return (
          <tr key={`${e.from}>${e.to}`}>
            <td>{gate ? '🌐 customers' : <button className="link" onClick={() => onPick(other)}>{landmarkFor(nameOf(other)).emoji} {nameOf(other)}</button>}</td>
            <td>{describeFlow(e)}</td>
            <td><i style={{ background: sig.color }} aria-hidden />{sig.icon} {sig.label}</td>
          </tr>
        )
      })}
    </tbody></table>
  </>
}

/** Bottom-left: the whole city's traffic at a glance, and every service that needs attention. */
function Overview({ flows, deployments, states, onPick }: {
  flows: RoadFlow[]; deployments: K8sObject[]; states: ServiceState; onPick: (k: string) => void
}) {
  const o = overview(flows)
  const list = deployments.filter((d) => states[keyOf(d)]?.affected).sort((a, b) => states[keyOf(b)].affected!.rank - states[keyOf(a)].affected!.rank)
  return (
    <section className="hud overview" aria-label="Traffic overview">
      <Tiles items={[
        { label: 'req/s coming in', value: o.rps < 10 ? o.rps.toFixed(1) : String(Math.round(o.rps)) },
        { label: 'avg latency', value: o.latency_ms == null ? '—' : `${Math.round(o.latency_ms)} ms`, status: o.rps > 0 && (o.latency_ms ?? 0) >= SLOW_MS ? 'slow' : undefined },
        { label: 'failing', value: pct(o.failing), status: o.failing >= ERROR_RATE ? 'errors' : undefined },
      ]} />
      <p className="muted small">Coming in: where requests enter the app. All {flows.length} routes: {o.allRps.toFixed(1)} req/s, {pct(o.allFailing)} failing.</p>
      {list.length ? (
        <ul className="affected" aria-label="Services that need attention">
          {list.map((d) => {
            const a = states[keyOf(d)].affected!
            return (
              <li key={d.metadata.uid}><button onClick={() => onPick(keyOf(d))} style={{ borderColor: a.color }}>
                <i style={{ background: a.color }} aria-hidden />{a.icon} <b>{d.metadata.name}</b> <span>{a.label}</span>
              </button></li>
            )
          })}
        </ul>
      ) : <p className="small">✓ Every service is healthy</p>}
    </section>
  )
}

/** What every colour and mark in the city means, with the thresholds behind them. */
function Legend({ live, districtColors, onClose }: { live: boolean; districtColors: ReadonlyMap<string, string>; onClose: () => void }) {
  return (
    <aside className="hud legend full" aria-label="Legend">
      <button className="close" onClick={onClose} aria-label="Close legend">×</button>
      {live && <>
        <h3>Building · application health</h3>
        <div><i style={{ background: '#0ca30c' }} />Healthy: backend reports usable healthy observations.</div>
        <div><i style={{ background: '#fab219' }} />Degraded: backend reports degraded application behaviour. Inspect measured p95 and HTTP 5xx.</div>
        <div><i style={{ background: '#d03b3b' }} />Unavailable: backend reports application unavailable.</div>
        <div><i style={{ background: '#94a3b8' }} />Unknown, idle or stale: no current healthy application claim.</div>
        <div>Data stores show Kubernetes health; HTTP application metrics do not apply. A 402 decline is a checkout outcome, not an infrastructure failure.</div>
      </>}
      <h3>{live ? 'Road response activity · separate from application health' : 'Roads and Building glow · requests'}</h3>
      {(['ok', 'slow', 'errors', 'refused', 'idle'] as Signal[]).map((s) => (
        <div key={s}><i style={{ background: SIGNAL[s].color }} />{SIGNAL[s].icon} <b>{SIGNAL[s].label}</b>: {SIGNAL[s].means}</div>
      ))}
      <h3>Needs attention</h3>
      <div>🚨 A pulsing ring around the Building, plus a beam of light when it is down, refusing or failing requests. Listed bottom left.</div>
      <h3>Units · Pods</h3>
      {(Object.keys(STATUS_COLOR) as PodStatus[]).map((s) => <div key={s}><i style={{ background: STATUS_COLOR[s] }} />{FRIENDLY[s]} <small>({s})</small></div>)}
      {districtColors.size > 1 && <>
        <h3>Lorry destinations</h3>
        <div>The glow matches the colour beside the district name on the map.</div>
        {[...districtColors].map(([name, color]) => <div key={name}><i style={{ background: color }} />{name}</div>)}
      </>}
      <h3>Cars · requests</h3>
      <div>Aggregate activity illustration, not request-level traces. Car count, travel time and Pod flashes are illustrative.</div>
      <div>🚕 Yellow taxis are customers; other Cars wear their caller's colour.</div>
      <div><i style={{ background: SIGNAL.errors.color }} />Comes back orange: answered with an error.</div>
      <div><i style={{ background: SIGNAL.refused.color }} />Comes back red: refused, nobody answered.</div>
      <div>🔴 Brake lights: slowing, or queuing behind the Car ahead.</div>
    </aside>
  )
}
