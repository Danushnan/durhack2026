import { useState } from 'react'
import { City, type HoverInfo, type ServiceState } from './City'
import {
  api, deploymentHealth, describeDeployment, describePod, FRIENDLY, HEALTH_COLOR, type K8sObject, keyOf, NODE_COLORS,
  type PodStatus, podStatus, STATUS_COLOR, useCluster,
} from './k8s'
import { landmarkFor } from './landmarks'
import { downServices, explain, impactChain, nameOf, roleOf } from './teach'
import { THEMES, useThemeMode } from './theme'

export default function App() {
  const cluster = useCluster()
  const [selected, setSelected] = useState<string | null>(null)
  const [powerGrid, setPowerGrid] = useState(false)
  const [hover, setHover] = useState<HoverInfo | null>(null)
  const [help, setHelp] = useState(false)
  const [sidebar, setSidebar] = useState(false)
  const [feedOpen, setFeedOpen] = useState(false)
  const [homeTick, setHomeTick] = useState(0)
  const [mode, setMode] = useThemeMode()
  const theme = THEMES[mode]

  const all = Object.values(cluster.objects)
  const nodes = all.filter((o) => o.kind === 'Node').sort((a, b) => a.metadata.name.localeCompare(b.metadata.name))
  const deployments = all.filter((o) => o.kind === 'Deployment').sort((a, b) => keyOf(a).localeCompare(keyOf(b)))
  const events = all.filter((o) => o.kind === 'Event').sort((a, b) =>
    Number(b.metadata.uid.slice(3)) - Number(a.metadata.uid.slice(3)))
  const dep = deployments.find((o) => keyOf(o) === selected)

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
        onHover={setHover} states={states} homeTick={homeTick} />

      <header className="hud brand">
        <h1>Port Kube</h1>
        <span className={`dot ${cluster.connected ? 'on' : ''}`} title={cluster.connected ? 'Live' : 'Reconnecting…'}
          aria-label={cluster.connected ? 'Live' : 'Reconnecting'} />
      </header>

      <nav className="hud controls" aria-label="View controls">
        <button aria-label="Reset the camera to the overview" title="Reset view"
          onClick={() => { setSelected(null); setHomeTick(homeTick + 1) }}>⌂</button>
        <button aria-label={`Switch to ${mode === 'night' ? 'day' : 'night'}`} title="Day / night"
          onClick={() => setMode(mode === 'night' ? 'day' : 'night')}>{mode === 'night' ? '🌙' : '☀️'}</button>
        <button aria-pressed={powerGrid} className={powerGrid ? 'on' : ''} title="Power Grid: colour each Unit by the Node it runs on"
          onClick={() => setPowerGrid(!powerGrid)}>⚡</button>
        <button aria-expanded={help} className={help ? 'on' : ''} title="How this city works" onClick={() => setHelp(!help)}>?</button>
      </nav>

      <Banner deployments={deployments} states={states} outages={outages} onPick={setSelected} />

      {help && <Help onClose={() => setHelp(false)} />}

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
      </aside>

      {dep && <Inspect dep={dep} all={all} events={events} states={states} edges={cluster.edges} onPick={setSelected} onClose={() => setSelected(null)} />}

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
      </ul>
      <h3>How Kubernetes thinks</h3>
      <p>You tell Kubernetes the <b>desired state</b> ("3 copies of the frontend"). A control loop constantly compares it with
        the <b>actual state</b> and fixes any difference: replacing crashed Pods, moving Pods off failed Nodes, adding or removing copies.</p>
      <h3>Try it</h3>
      <ul>
        <li>Open a Building and <b>Demolish</b> a Unit: watch a replacement appear.</li>
        <li><b>Sabotage</b> the Bank: payments go down and checkout becomes <span className="amber">impacted</span>.</li>
        <li>Click a <b>Power Station</b> to cut its power: its Pods get rescheduled, and some wait for space.</li>
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

function Action({ label, hint, onClick, bad, disabled }: { label: string; hint: string; onClick: () => void; bad?: boolean; disabled?: boolean }) {
  return (
    <button className={`action ${bad ? 'bad' : ''}`} onClick={onClick} disabled={disabled}>
      {label}<small>{hint}</small>
    </button>
  )
}

function Inspect({ dep, all, events, states, edges, onPick, onClose }: {
  dep: K8sObject; all: K8sObject[]; events: K8sObject[]; states: ServiceState
  edges: { from: string; to: string }[]; onPick: (k: string) => void; onClose: () => void
}) {
  const ns = dep.metadata.namespace!, name = dep.metadata.name, key = keyOf(dep)
  const info = landmarkFor(name), role = roleOf(name), state = states[key]
  const pods = all.filter((o) => o.kind === 'Pod' && o.metadata.namespace === ns && o.metadata.labels?.app === name)
    .sort((a, b) => (a.metadata.creationTimestamp ?? '').localeCompare(b.metadata.creationTimestamp ?? ''))
  const mine = events.filter((e) => e.involvedObject?.namespace === ns &&
    (e.involvedObject.name === name || e.involvedObject.name.startsWith(`${name}-`))).slice(0, 6)
  const sabotaged = dep.metadata.annotations?.['kubeverse.io/sabotaged'] === 'true'
  const replicas: number = dep.spec.replicas
  const dependsOn = edges.filter((e) => e.from === key).map((e) => e.to)
  const usedBy = edges.filter((e) => e.to === key).map((e) => e.from)
  const chip = (k: string) => (
    <button key={k} className={`chip ${states[k]?.down ? 'bad' : states[k]?.chain ? 'warn' : ''}`} onClick={() => onPick(k)}>
      {landmarkFor(nameOf(k)).emoji} {nameOf(k)}
    </button>
  )
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
      <h3>Try it</h3>
      <div className="actions">
        <Action label="➕ Add Unit" hint="Desired +1: Kubernetes creates a Pod" disabled={replicas >= 10}
          onClick={() => api.scale(ns, name, replicas + 1)} />
        <Action label="➖ Remove Unit" hint="Desired −1: Kubernetes stops one" disabled={replicas <= 0}
          onClick={() => api.scale(ns, name, replicas - 1)} />
        {sabotaged
          ? <Action label="🔧 Repair" hint="Next restart succeeds" onClick={() => api.sabotage(ns, name, false)} />
          : <Action bad label="💣 Sabotage" hint="Pods crash; see who's impacted" onClick={() => api.sabotage(ns, name, true)} />}
      </div>
      <h3>Units <small>(Pods) · {dep.status.readyReplicas ?? 0} of {replicas} ready</small></h3>
      <table>
        <tbody>
          {pods.map((p) => {
            const s = podStatus(p)
            return (
              <tr key={p.metadata.uid}>
                <td><i style={{ background: STATUS_COLOR[s] }} />{p.metadata.name}</td>
                <td>{describePod(p)}<small>{s}</small></td>
                <td title="Restarts">↻ {p.status.containerStatuses[0].restartCount}</td>
                <td title="Node (Power Station)">{p.spec.nodeName ?? '—'}</td>
                <td>{s !== 'Terminating' && (
                  <button className="bad small" title="Delete this Pod and watch Kubernetes replace it"
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
