import { useState } from 'react'
import { City, type HoverInfo } from './City'
import {
  api, deploymentHealth, describeDeployment, describePod, FRIENDLY, HEALTH_COLOR, type K8sObject, keyOf, NODE_COLORS,
  type PodStatus, podStatus, STATUS_COLOR, useCluster,
} from './k8s'
import { landmarkFor } from './landmarks'
import { THEMES, useThemeMode } from './theme'

export default function App() {
  const cluster = useCluster()
  const [selected, setSelected] = useState<string | null>(null)
  const [powerGrid, setPowerGrid] = useState(false)
  const [hover, setHover] = useState<HoverInfo | null>(null)
  const [mode, setMode] = useThemeMode()
  const theme = THEMES[mode]

  const all = Object.values(cluster.objects)
  const nodes = all.filter((o) => o.kind === 'Node').sort((a, b) => a.metadata.name.localeCompare(b.metadata.name))
  const deployments = all.filter((o) => o.kind === 'Deployment').sort((a, b) => keyOf(a).localeCompare(keyOf(b)))
  const events = all.filter((o) => o.kind === 'Event').sort((a, b) =>
    Number(b.metadata.uid.slice(3)) - Number(a.metadata.uid.slice(3)))
  const dep = deployments.find((o) => keyOf(o) === selected)

  return (
    <div className={`app ${mode}`}>
      <City cluster={cluster} selected={selected} onSelect={setSelected} powerGrid={powerGrid} theme={theme} onHover={setHover} />

      <header className="hud top">
        <h1>Port Kube <small>KubeVerse · Watch Kubernetes Think</small></h1>
        <span className={`dot ${cluster.connected ? 'on' : ''}`}>{cluster.connected ? 'live' : 'reconnecting…'}</span>
        <button aria-label={`Switch to ${mode === 'night' ? 'day' : 'night'} mode`} title="Day / night"
          onClick={() => setMode(mode === 'night' ? 'day' : 'night')}>{mode === 'night' ? '🌙 Night' : '☀️ Day'}</button>
        <label title="Colour each Unit by the machine (Node) it runs on">
          <input type="checkbox" checked={powerGrid} onChange={(e) => setPowerGrid(e.target.checked)} /> Power Grid
        </label>
        <div className="nodes" aria-label="Machines (Nodes)">
          {nodes.map((n, i) => {
            const ready = n.status.conditions[0].status === 'True'
            return (
              <button key={n.metadata.uid} className={ready ? '' : 'bad'} style={{ borderColor: NODE_COLORS[i % NODE_COLORS.length] }}
                title={ready ? `Cut power to ${n.metadata.name}: its Units are evicted and must move elsewhere`
                  : `Restore power to ${n.metadata.name}`}
                onClick={() => api.outage(n.metadata.name, ready)}>
                {ready ? '⚡' : '🔌'} {n.metadata.name} <small>{ready ? 'cut power' : 'restore'}</small>
              </button>
            )
          })}
        </div>
      </header>

      <aside className="hud services">
        <h3>Buildings (services)</h3>
        {deployments.map((d) => {
          const info = landmarkFor(d.metadata.name), h = deploymentHealth(d)
          return (
            <button key={d.metadata.uid} className={`svc ${selected === keyOf(d) ? 'sel' : ''}`} onClick={() => setSelected(keyOf(d))}>
              <span>{info.emoji} {d.metadata.name}</span>
              <small style={{ color: HEALTH_COLOR[h] }}>{describeDeployment(d)}</small>
            </button>
          )
        })}
        <details open>
          <summary>How to read this city</summary>
          <ul className="howto">
            <li>🏙️ Each <b>District</b> is a namespace.</li>
            <li>🏦 Each <b>Building</b> is a service (Deployment).</li>
            <li>▪️ Small blocks in front are its <b>Units</b> (Pods), the copies doing the work.</li>
            <li>⬚ An outlined <b>Plot</b> is a Unit Kubernetes still has to create.</li>
            <li>🚗 <b>Cars</b> are requests. A <span style={{ color: '#ef4444' }}>red car</span> with hazards turning back is a failed request.</li>
          </ul>
          <div className="legend">
            {powerGrid
              ? nodes.map((n, i) => <span key={n.metadata.uid}><i style={{ background: NODE_COLORS[i % NODE_COLORS.length] }} />{n.metadata.name}</span>)
              : (Object.keys(STATUS_COLOR) as PodStatus[]).map((s) => <span key={s}><i style={{ background: STATUS_COLOR[s] }} />{FRIENDLY[s]}</span>)}
          </div>
        </details>
      </aside>

      {dep && <Inspect dep={dep} all={all} events={events} onClose={() => setSelected(null)} />}

      <aside className="hud feed" aria-live="polite">
        <h3>What Kubernetes is doing</h3>
        {events.slice(0, 6).map((e) => <EventRow key={e.metadata.uid} e={e} />)}
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

function EventRow({ e }: { e: K8sObject }) {
  return (
    <div className={`event ${e.type === 'Warning' ? 'bad' : ''}`} title={e.message}>
      <b>{e.reason}</b> {e.involvedObject?.name}: {e.message}
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

function Inspect({ dep, all, events, onClose }: { dep: K8sObject; all: K8sObject[]; events: K8sObject[]; onClose: () => void }) {
  const ns = dep.metadata.namespace!, name = dep.metadata.name
  const info = landmarkFor(name)
  const pods = all.filter((o) => o.kind === 'Pod' && o.metadata.namespace === ns && o.metadata.labels?.app === name)
    .sort((a, b) => (a.metadata.creationTimestamp ?? '').localeCompare(b.metadata.creationTimestamp ?? ''))
  const mine = events.filter((e) => e.involvedObject?.namespace === ns &&
    (e.involvedObject.name === name || e.involvedObject.name.startsWith(`${name}-`))).slice(0, 8)
  const sabotaged = dep.metadata.annotations?.['kubeverse.io/sabotaged'] === 'true'
  const replicas: number = dep.spec.replicas
  const h = deploymentHealth(dep)

  return (
    <aside className="hud inspect" aria-label={`${name} details`}>
      <button className="close" onClick={onClose} aria-label="Close">×</button>
      <h2>{info.emoji} {info.title} <small>{name} · {ns}</small></h2>
      <p className="summary" style={{ color: HEALTH_COLOR[h] }}>{describeDeployment(dep)}</p>
      <div className="actions">
        <Action label="➕ Add a Unit" hint="Scale up: ask for one more Pod" disabled={replicas >= 10}
          onClick={() => api.scale(ns, name, replicas + 1)} />
        <Action label="➖ Remove a Unit" hint="Scale down: Kubernetes picks one to stop" disabled={replicas <= 0}
          onClick={() => api.scale(ns, name, replicas - 1)} />
        {sabotaged
          ? <Action label="🔧 Repair" hint="New starts will succeed again" onClick={() => api.sabotage(ns, name, false)} />
          : <Action bad label="💣 Sabotage" hint="Every Unit crashes on start; watch it retry" onClick={() => api.sabotage(ns, name, true)} />}
      </div>
      <h3>Units <small>(Pods)</small></h3>
      <table>
        <tbody>
          {pods.map((p) => {
            const s = podStatus(p)
            return (
              <tr key={p.metadata.uid}>
                <td><i style={{ background: STATUS_COLOR[s] }} />{p.metadata.name}</td>
                <td>{describePod(p)}<small>{s}</small></td>
                <td title="Restarts">↻ {p.status.containerStatuses[0].restartCount}</td>
                <td title="Machine (Node)">{p.spec.nodeName ?? '—'}</td>
                <td>{s !== 'Terminating' && (
                  <button className="bad" title="Demolish: delete this Pod and watch Kubernetes replace it"
                    onClick={() => api.demolish(ns, p.metadata.name)}>Demolish</button>
                )}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <h3>Recent events</h3>
      {mine.map((e) => <EventRow key={e.metadata.uid} e={e} />)}
    </aside>
  )
}
