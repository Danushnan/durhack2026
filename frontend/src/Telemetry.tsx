import { useEffect, useState } from 'react'
import { nameOf } from './teach'

interface Measurement {
  service: string
  latency_ms: number
  error_rate: number
}

interface Metrics extends Measurement {
  requests: number
  rps: number
}

export interface ServiceMetrics extends Metrics {
  baseline_ms: number | null
  anomaly: boolean
}

export interface RouteMetrics extends Metrics {
  caller: string
}

type Snapshot =
  | { status: 'disabled' | 'connecting' | 'waiting' | 'unavailable' }
  | {
      status: 'ready'
      at: string
      oldest: string
      latest: string
      services: ServiceMetrics[]
      routes: RouteMetrics[]
      incidents: { service: string; changed_at: string; path: string[]; timeline: (Measurement & { bucket: string })[] }[]
    }

export const routeKey = (from: string, to: string) => `${from}→${to}`

export function useTelemetry(at: number | null, enabled = true) {
  const [snapshot, setSnapshot] = useState<Snapshot>({ status: 'waiting' })
  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    async function refresh() {
      try {
        const query = at === null ? '' : `?at=${encodeURIComponent(new Date(at).toISOString())}`
        const response = await fetch(`/api/telemetry${query}`, { signal: controller.signal })
        if (!response.ok) throw new Error(String(response.status))
        const data: Snapshot = await response.json()
        if (!controller.signal.aborted) setSnapshot(data)
        if (!controller.signal.aborted && (at === null || data.status !== 'ready')) {
          timer = setTimeout(refresh, 2000)
        }
      } catch {
        if (controller.signal.aborted) return
        setSnapshot({ status: 'unavailable' })
        timer = setTimeout(refresh, 2000)
      }
    }
    timer = setTimeout(refresh, at === null ? 0 : 150)
    return () => { controller.abort(); clearTimeout(timer) }
  }, [at, enabled])
  return enabled ? snapshot : { status: 'disabled' as const }
}

const clock = (iso: string) => new Date(iso).toLocaleTimeString()
const percent = (rate: number) => `${(rate * 100).toFixed(1)}%`

export function Telemetry({ snapshot, at, onSeek, onClose }: {
  snapshot: Snapshot; at: number | null; onSeek: (at: number | null) => void; onClose: () => void
}) {
  const message = {
    disabled: 'Set TIGERDATA_DATABASE_URL in backend/.env and restart the backend.',
    connecting: 'Connecting to TigerData…',
    waiting: 'Waiting for the first request measurements…',
    unavailable: 'TigerData queries are temporarily unavailable. Retrying…',
  }
  return (
    <aside className="hud telemetry" aria-label="Network analytics">
      <button className="close" onClick={onClose} aria-label="Close network analytics">×</button>
      <h2>Network analytics</h2>
      <p className="muted">Simulated request telemetry · TigerData</p>
      {snapshot.status !== 'ready' ? <p role="status">{message[snapshot.status]}</p> : <>
        <div className="telemetry-time">
          <label htmlFor="telemetry-time">Network at {clock(snapshot.at)}</label>
          <button onClick={() => onSeek(null)} disabled={at === null}>Go live</button>
        </div>
        <input id="telemetry-time" type="range" min={Date.parse(snapshot.oldest)} max={Date.parse(snapshot.latest)}
          step={1000} value={at ?? Date.parse(snapshot.latest)}
          aria-valuetext={clock(new Date(at ?? Date.parse(snapshot.latest)).toISOString())}
          onChange={(event) => onSeek(event.currentTarget.valueAsNumber)} />
        <p className="muted">{at === null ? 'Live' : 'Replay · city resources stay live'} · trailing 10 seconds</p>
        <table>
          <thead><tr><th>Service</th><th>Requests</th><th>Avg latency</th><th>Errors</th></tr></thead>
          <tbody>{snapshot.services.map((row) => <tr key={row.service}>
            <th scope="row">{nameOf(row.service)}</th>
            <td>{row.requests} <small>({row.rps.toFixed(1)}/s)</small></td>
            <td>{Math.round(row.latency_ms)} ms</td>
            <td>{percent(row.error_rate)}</td>
          </tr>)}</tbody>
        </table>
        {snapshot.services.filter((row) => row.anomaly).map((row) =>
          <p key={row.service} className="red">{nameOf(row.service)} latency anomaly · {Math.round(row.latency_ms)} ms vs {Math.round(row.baseline_ms!)} ms baseline</p>
        )}
        <h3>Possible failure propagation</h3>
        {snapshot.incidents.length === 0 && <p className="muted">No incident detected in the last two minutes.</p>}
        {snapshot.incidents.map((incident) => (
          <details key={incident.path.join('>')}>
            <summary>{clock(incident.changed_at)} · {incident.path.map(nameOf).join(' → ')}</summary>
            <ul>{incident.timeline.map((row) => <li key={row.bucket}>
              {clock(row.bucket)} · {Math.round(row.latency_ms)} ms · {percent(row.error_rate)} errors
            </li>)}</ul>
          </details>
        ))}
      </>}
    </aside>
  )
}
