import { useEffect, useState } from 'react'
import { City, type HoverInfo, type ServiceState } from './City'
import {
  ACTION_FAILED, api, deploymentHealth, describeDeployment, describePod, FRIENDLY, HEALTH_COLOR, isWorkload, type K8sObject, keyOf, NODE_COLORS,
  podsOf, type PodStatus, podStatus, rolloutOf, versionColor, STATUS_COLOR, useCluster,
} from './k8s'
import { landmarkFor } from './landmarks'
import { COMPONENTS, downServices, explain, impactChain, kubectl, nameOf, roleOf } from './teach'
import { THEMES, useThemeMode } from './theme'
import { routeKey, Telemetry, useTelemetry } from './Telemetry'

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
  const telemetry = useTelemetry(replayAt)
  const services = telemetry.status === 'ready' ? Object.fromEntries(telemetry.services.map((row) => [row.service, row])) : {}
  const routes = telemetry.status === 'ready' ? Object.fromEntries(telemetry.routes.map((row) => [routeKey(row.caller, row.service), row])) : {}
  const [toast, setToast] = useState<string | null>(null)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const show = (e: Event) => { setToast((e as CustomEvent<string>).detail); clearTimeout(timer); timer = setTimeout(() => setToast(null), 6000) }
    window.addEventListener(ACTION_FAILED, show)
    return () => { window.removeEventListener(ACTION_FAILED, show); clearTimeout(timer) }
  }, [])
  const [mode, setMode] = useThemeMode()
  const theme = THEMES[mode]

  const all = Object.values(cluster.objects)
  const nodes = all.filter((o) => o.kind === 'Node').sort((a, b) => a.metadata.name.localeCompare(b.metadata.name))
  const deployments = all.filter(isWorkload).sort((a, b) => keyOf(a).localeCompare(keyOf(b)))
  const events = all.filter((o) => o.kind === 'Event').sort((a, b) =>
    Number(b.metadata.uid.slice(3)) - Number(a.metadata.uid.slice(3)))
  const dep = deployments.find((o) => keyOf(o) === selected)
  const node = selected?.startsWith('node:') ? nodes.find((n) => n.metadata.name === selected.slice(5)) : undefined
  const sim = cluster.connected && !cluster.live // simulator-only actions are hidden when watching a real cluster
  const rush = all.some((o) => o.kind === 'Ingress' && o.status?.['kubeverse.io/rush-hour'])

  const down = downServices(deployments)
  const states: ServiceState = Object.fromEntries(deployments.map((d) => {
    const k = keyOf(d)
    return [k, { down: down.has(k), chain: down.has(k) ? null : impactChain(k, cluster.edges, down) }]
  }))
  const unhealthyPods = all.some((o) => o.kind === 'Pod' && podStatus(o) !== 'Running')
  const outages = nodes.filter((n) => n.status.conditions[0].status !== 'True')

  return (
    <div className={`app ${mode}`}>
      <City cluster={cluster} selected={selected} onSelect={setSelected} powerGrid={powerGrid} theme={theme}
        onHover={setHover} states={states} homeTick={homeTick}
        serviceMetrics={services} routeMetrics={routes} replay={replayAt !== null} />

      <header className="hud brand">
        <h1>Kuebec <small>Port Kube</small></h1>
        <span className={`dot ${cluster.connected ? 'on' : ''}`} title={cluster.connected ? 'Live' : 'Reconnecting…'}
          aria-label={cluster.connected ? 'Live' : 'Reconnecting'} />
        {cluster.live && <span className="badge" title="Watching a real Kubernetes cluster through kubectl. Simulator controls are hidden.">
          live cluster · {cluster.live} · read-only</span>}
      </header>

      <nav className="hud controls" aria-label="View controls">
        <button aria-label="Reset the camera to the overview" title="Reset view"
          onClick={() => { setSelected(null); setHomeTick(homeTick + 1) }}>⌂</button>
        <button aria-label={`Switch to ${mode === 'night' ? 'day' : 'night'}`} title="Day / night"
          onClick={() => setMode(mode === 'night' ? 'day' : 'night')}>{mode === 'night' ? '🌙' : '☀️'}</button>
        <button aria-pressed={powerGrid} className={powerGrid ? 'on' : ''} title="Power Grid: colour each Unit by the Node it runs on"
          onClick={() => setPowerGrid(!powerGrid)}>⚡</button>
        {sim && <button aria-pressed={rush} className={rush ? 'on' : ''} aria-label={rush ? 'End rush hour' : 'Start rush hour'}
          title="Rush hour: triple the customers at the City Gate and watch the autoscaler react" onClick={() => api.rushHour(!rush)}>🚦</button>}
        {sim && <button aria-label="Reset the city to its starting state" title="Reset city"
          onClick={() => { if (window.confirm('Reset Port Kube to its starting state? Every change you made will be undone.')) { setSelected(null); api.reset() } }}>⟲</button>}
        <button aria-expanded={help} className={help ? 'on' : ''} title="How this city works" onClick={() => setHelp(!help)}>?</button>
        <button aria-expanded={analyticsOpen} className={analyticsOpen ? 'on' : ''} title="Network analytics"
          aria-label="Network analytics" onClick={() => {
            if (analyticsOpen) setReplayAt(null)
            setAnalyticsOpen(!analyticsOpen)
          }}>▥</button>
      </nav>

      <Banner deployments={deployments} states={states} outages={outages} onPick={setSelected} />

      {help && <Help onClose={() => setHelp(false)} />}
      {analyticsOpen && <Telemetry snapshot={telemetry} at={replayAt} onSeek={setReplayAt} onClose={() => {
        setReplayAt(null)
        setAnalyticsOpen(false)
      }} />}

      <aside className={`hud services ${sidebar ? 'open' : ''}`} aria-label="Services">
        <button className="toggle" aria-expanded={sidebar} title={sidebar ? 'Collapse' : 'Show service names'}
          onClick={() => setSidebar(!sidebar)}>{sidebar ? '‹' : '›'}</button>
        {deployments.map((d) => {
          const info = landmarkFor(d.metadata.name), k = keyOf(d), s = states[k]
          const color = s.down ? '#ef4444' : s.chain ? '#f59e0b' : HEALTH_COLOR[deploymentHealth(d)]
          return (
            <button key={d.metadata.uid} className={`svc ${selected === k ? 'sel' : ''}`} onClick={() => setSelected(k)}
              title={`${info.title}: ${d.metadata.name}. ${roleOf(d.metadata.name).does}`} aria-label={`${d.metadata.name}, ${describeDeployment(d)}`}>
              <span className="emoji">{info.emoji}<i className="pip" style={{ background: color }} /></span>
              {sidebar && <span className="svc-text"><b>{d.metadata.name}</b><small>{s.down ? 'Down' : s.chain ? 'Impacted' : describeDeployment(d)}</small></span>}
            </button>
          )
        })}
        <hr />
        <button className={`svc ${selected === 'city-hall' ? 'sel' : ''}`} onClick={() => setSelected('city-hall')}
          title="City Hall: the control plane" aria-label="City Hall, the control plane">
          <span className="emoji">🏛️</span>{sidebar && <span className="svc-text"><b>City Hall</b><small>control plane</small></span>}
        </button>
        {nodes.map((n, i) => {
          const ready = n.status.conditions[0].status === 'True'
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
      {dep && <Inspect dep={dep} all={all} events={events} states={states} edges={cluster.edges} sim={sim} onPick={setSelected} onClose={() => setSelected(null)} />}

      {(powerGrid || unhealthyPods) && (
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
function Banner({ deployments, states, outages, onPick }: {
  deployments: K8sObject[]; states: ServiceState; outages: K8sObject[]; onPick: (k: string) => void
}) {
  const downDeps = deployments.filter((d) => states[keyOf(d)]?.down)
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

function Help({ onClose }: { onClose: () => void }) {
  return (
    <div className="hud help" role="dialog" aria-label="How this city works">
      <button className="close" onClick={onClose} aria-label="Close">×</button>
      <h2>How Port Kube works</h2>
      <p>Port Kube is a shop's software running on <b>Kubernetes</b>, drawn as a city.</p>
      <ul>
        <li>🏦 <b>Buildings</b> are services (Deployments). Each does one job: hover one to see what. A bigger Building means more copies were asked for.</li>
        <li>🏙️ Towers, houses and trees around the edge are just scenery.</li>
        <li>▪️ <b>Units</b> in front are its Pods: identical copies doing the work. ⬚ An outlined <b>Plot</b> is a Pod still being created.</li>
        <li>🛣️ A <b>Road</b> exists only where one service calls another. Its centre line is blue while calls succeed and <span className="red">red</span> when they fail.</li>
        <li>🚗 <b>Cars</b> are requests driving from the caller to the service it needs. A <span className="red">red car</span> turning back is a failed request.</li>
        <li>⚡ <b>Power Stations</b> are Nodes: the machines Pods run on. Their lights show used Pod slots.</li>
        <li>🌐 The <b>City Gate</b> is an Ingress: customers from the internet enter there and go to the frontend.</li>
        <li>🏛️ <b>City Hall</b> is the control plane. Glowing <b>messengers</b> fly out for each decision; their colour says which part decided.</li>
        <li>🛢️ <b>Storage tanks</b> beside the Archive are its volumes: the database is a <b>StatefulSet</b>, so its data outlives its Pods.</li>
        <li>🚗 A car that returns <span className="amber">orange</span> got an error (the service needed something that is down); <span className="red">red</span> means nobody could answer at all.</li>
        <li>🎨 A Unit's cap colour is its <b>version</b>. A Unit only gets requests once it is <b>ready</b>; each delivery flashes the Unit that served it.</li>
      </ul>
      <h3>How Kubernetes thinks</h3>
      <p>You tell Kubernetes the <b>desired state</b> ("3 copies of the frontend"). A control loop constantly compares it with
        the <b>actual state</b> and fixes any difference: replacing crashed Pods, moving Pods off failed Nodes, adding or removing copies.</p>
      <h3>Try it</h3>
      <ul>
        <li>Open a Building and <b>Demolish</b> a Unit: watch a replacement appear.</li>
        <li><b>Release</b> a new version of the Bank and watch caps change colour one Unit at a time; release a <b>buggy</b> one and see the rollout stall while the old version keeps serving, then <b>Roll back</b>.</li>
        <li><b>Sabotage</b> the Bank: every copy crashes, payments go down and checkout becomes <span className="amber">impacted</span>.</li>
        <li>Click a <b>Power Station</b>: compare planned <b>maintenance</b> (Units move out gently, respecting budgets) with a sudden <b>power cut</b>.</li>
        <li>Press <b>🚦</b> for rush hour: customers triple, the autoscaler adds frontend Units, roads fill up, and later it scales back down.</li>
        <li><b>⟲</b> puts the city back to how it started.</li>
      </ul>
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
  const ready = dep.status.readyReplicas ?? 0
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

function Inspect({ dep, all, events, states, edges, sim, onPick, onClose }: {
  dep: K8sObject; all: K8sObject[]; events: K8sObject[]; states: ServiceState
  edges: { from: string; to: string }[]; sim: boolean; onPick: (k: string) => void; onClose: () => void
}) {
  const ns = dep.metadata.namespace!, name = dep.metadata.name, key = keyOf(dep)
  const info = landmarkFor(name), role = roleOf(name), state = states[key]
  const pods = podsOf(dep, all.filter((o) => o.kind === 'Pod'))
    .sort((a, b) => (a.metadata.creationTimestamp ?? '').localeCompare(b.metadata.creationTimestamp ?? ''))
  const stateful = dep.kind === 'StatefulSet'
  const hpa = all.find((o) => o.kind === 'HorizontalPodAutoscaler' && o.metadata.namespace === ns && o.spec.scaleTargetRef.name === name)
  const claims = all.filter((o) => o.kind === 'PersistentVolumeClaim' && o.metadata.namespace === ns && o.metadata.labels?.app === name)
  const pdb = all.find((o) => o.kind === 'PodDisruptionBudget' && o.metadata.namespace === ns && o.metadata.name === name)
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
  const now = state?.down
    ? { cls: 'bad', text: `💥 Down. ${role.ifDown}` }
    : state?.chain
      ? { cls: 'warn', text: `⚠ Impacted: it is running, but ${state.chain.map(nameOf).join(' → ')} ${state.chain.length > 1 ? 'chain is' : 'is'} down, so its requests fail.` }
      : { cls: deploymentHealth(dep) === 'healthy' ? 'ok' : 'warn', text: describeDeployment(dep) }

  return (
    <aside className="hud inspect" aria-label={`${name} details`}>
      <button className="close" onClick={onClose} aria-label="Close">×</button>
      <h2>{info.emoji} {info.title} <small>{name} · {ns}</small></h2>
      <p className="does">{role.does}</p>
      <p className={`now ${now.cls}`}>{now.text}</p>
      <dl className="facts">
        <dt>If it stops</dt><dd>{role.ifDown}</dd>
        {dependsOn.length > 0 && <><dt>Needs</dt><dd>{dependsOn.map(chip)}</dd></>}
        {usedBy.length > 0 && <><dt>Used by</dt><dd>{usedBy.map(chip)}</dd></>}
      </dl>
      <h3>Desired vs actual</h3>
      <DesiredActual dep={dep} pods={pods} />
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
      <h3>Units <small>(Pods) · {dep.status.readyReplicas ?? 0} of {replicas} ready</small></h3>
      <table>
        <tbody>
          {pods.map((p) => {
            const s = podStatus(p)
            return (
              <tr key={p.metadata.uid}>
                <td><i style={{ background: STATUS_COLOR[s] }} />{p.metadata.name}<small><i style={{ background: versionColor(p.metadata.labels?.version ?? 'v1') }} />{p.metadata.labels?.version ?? 'v1'}</small></td>
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
  const ready = node.status.conditions[0].status === 'True'
  const cordoned = !!node.spec?.unschedulable
  const drain: string = node.metadata.annotations?.['kubeverse.io/drain'] ?? ''
  const pods = all.filter((o) => o.kind === 'Pod' && o.spec?.nodeName === name)
  const capacity = Number(node.status.capacity.pods)
  const state = !ready ? { cls: 'bad', text: '🔌 Power cut: the Node stopped responding. Its Pods are stuck Terminating until it returns; Deployments start replacements elsewhere, the StatefulSet waits.' }
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
          {ready
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
      {events.filter((e) => COMPONENTS[e.reportingComponent ?? '']).slice(0, 8).map((e) => (
        <div key={e.metadata.uid} className="event"><i style={{ background: COMPONENTS[e.reportingComponent!].color }} />
          <b>{e.reason}</b> {e.involvedObject?.name}: {explain(e) || e.message}</div>
      ))}
    </aside>
  )
}
