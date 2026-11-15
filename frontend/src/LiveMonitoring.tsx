import { type ClusterState, type K8sObject, keyOf } from './k8s'
import { label, latencyText, numberText, rateText, summarizeLive, type LiveServiceView } from './liveMetrics'

const timestamp = (value: string | null | undefined) => value ? new Date(value).toLocaleTimeString() : 'Never'

/** Reuses the inspector's facts and tiles; raw nullable values are never coerced to zero. */
export function LiveServiceDetails({ view, cluster, dep }: { view: LiveServiceView; cluster: ClusterState; dep: K8sObject }) {
  const m = view.metrics
  return <section className="live-measurements" aria-label="Live service measurements">
    <p className={`now ${view.application === 'degraded' ? 'warn' : view.application === 'unavailable' ? 'bad' : view.application === 'healthy' ? 'ok' : ''}`}>
      Application: {label(view.application)}
    </p>
    <p className={`now ${view.infrastructure === 'healthy' ? 'ok' : view.infrastructure === 'unavailable' ? 'bad' : 'warn'}`}>
      Infrastructure: {label(view.infrastructure)} · {numberText(m ? m.ready_replicas : dep.status?.readyReplicas)}/{numberText(m ? m.desired_replicas : dep.spec?.replicas)} Ready
    </p>
    <p className="measurement-state" role="status">Telemetry: {label(view.availability)}
      {m && <> · {m.measurement_kind === 'unsupported' ? 'HTTP metrics unsupported' : m.window_complete ? 'Complete window'
        : m.request_count === null ? 'Incomplete window · measurements unavailable' : 'Incomplete window · observed lower bounds'}</>}
      {!view.current && m && ' · last known values'}
    </p>
    {!m ? <p className="muted">No matching MiniShop measurement snapshot for this workload.</p> : <>
      <h3>Measured HTTP activity <small>· last {cluster.metrics?.window.seconds} seconds</small></h3>
      <div className="tiles">
        {[
          ['Requests', numberText(m.request_count)], ['Requests/s', numberText(m.requests_per_second, 2)],
          ['Avg latency', latencyText(m.avg_latency_ms)], ['p95 latency', latencyText(m.p95_latency_ms)],
          ['HTTP 5xx', numberText(m.error_count)], ['HTTP 5xx rate', rateText(m.error_rate)],
        ].map(([title, value]) => <div className="tile" key={title}><b>{value}</b><span>{title}</span></div>)}
      </div>
      <dl className="facts measurement-facts">
        <dt title="All HTTP 4xx responses; not proof that every rejection was expected.">HTTP 4xx rejections</dt><dd>{numberText(m.business_rejection_count)}</dd>
        <dt title="HTTP 402 responses are a subset of 4xx rejections, not additional failures.">402 payment declines</dt><dd>{numberText(m.business_decline_count)}</dd>
        {m.checkout && <>
          <dt title="Successful completed checkout HTTP attempts / all attempts. Retries count separately; this is not an order count.">Checkout success</dt>
          <dd>{rateText(m.checkout.success_rate)} · {m.checkout.success_count}/{m.checkout.attempt_count} HTTP attempts</dd>
          <dt>Checkout outcomes</dt><dd>{m.checkout.business_rejection_count} rejected (4xx) · {m.checkout.failure_count} failed (5xx)</dd>
        </>}
        <dt>Last successful log read</dt><dd>{timestamp(m.last_log_poll_at)}</dd>
        <dt>Last request completion</dt><dd>{timestamp(m.last_event_at)}</dd>
        <dt>Snapshot observed</dt><dd>{timestamp(cluster.metrics?.observed_at)}</dd>
      </dl>
      {m.availability === 'idle' && <p className="muted small">No incoming requests in this window. Application health is unknown without observations.</p>}
      {m.measurement_kind === 'unsupported' && <p className="muted small">Kubernetes health is available. Incoming HTTP RPS and latency do not apply to this data store.</p>}
    </>}
  </section>
}

export function LiveSourceStatus({ cluster }: { cluster: ClusterState }) {
  const m = cluster.metrics
  const warning = !cluster.connected ? 'Disconnected · last known data' : cluster.awaitingSnapshot ? 'Reconciling source snapshot…'
    : cluster.metricsError ?? (cluster.metricsStale ? 'Stale · no metrics snapshots for over 10 seconds'
      : !m ? 'Waiting for MiniShop telemetry…' : `Telemetry ${m.source.status}${cluster.stale ? ' · Kubernetes data stale' : ''}`)
  const unhealthy = !cluster.connected || cluster.awaitingSnapshot || cluster.metricsError || cluster.metricsStale || cluster.stale || !m || m.source.status !== 'connected'
  return <span className={`source-status ${unhealthy ? 'source-warning' : ''}`} role="status" title={`${m?.source_id ?? cluster.context ?? ''}${m ? ` · observed ${m.observed_at}` : ''}`}>
    {unhealthy && '⚠ '}{warning}{m?.source.error && <span className="source-error"> · {m.source.error}</span>}
  </span>
}

export function LiveOverview({ cluster, views, onPick }: {
  cluster: ClusterState; views: Record<string, LiveServiceView>; onPick: (key: string) => void
}) {
  const m = cluster.metrics
  const totals = m ? summarizeLive(m) : null
  const current = !!m && cluster.connected && !cluster.awaitingSnapshot && !cluster.metricsStale && !cluster.metricsError
  const rows = Object.entries(views).filter(([, view]) => view.metrics)
  const appRows = rows.filter(([, v]) => v.application !== 'not_applicable')
  const count = (status: string) => appRows.filter(([, v]) => v.application === status).length
  const notes = rows.filter(([, v]) => v.affected || ['partial', 'stale', 'unavailable', 'disconnected'].includes(v.availability))
  return <section className="hud overview live-overview" aria-label="MiniShop monitoring overview">
    <details className="monitor-disclosure">
      <summary><b>MiniShop · {m ? `${m.window.seconds}s observation window` : 'live monitoring'}</b>
        <LiveSourceStatus cluster={cluster} />
      </summary>
    <div className={`tiles ${current ? '' : 'last-known'}`}>
      {[
        ['HTTP service completions', numberText(totals?.requests)], ['Service requests/s', numberText(totals?.rps, 2)],
        ['Weighted avg latency', latencyText(totals?.average)], ['Highest service p95', latencyText(totals?.highestP95)],
        ['HTTP 5xx', numberText(totals?.errors)], ['HTTP 5xx rate', rateText(totals?.errorRate)],
      ].map(([title, value]) => <div className="tile" key={title}><b>{value}</b><span>{title}</span></div>)}
    </div>
    <p className="small muted">{!current && 'Last known values. '}{totals ? `${totals.coverage}/${totals.supported} HTTP services measured · ${totals.complete ? 'complete window' : totals.coverage ? 'incomplete; observed lower bounds' : 'measurements unavailable'}. ` : ''}</p>
    <p className="small muted" title="Includes multiple services in one journey. Highest service p95 is not a combined percentile.">Service completions across APIs, not unique shopping sessions.</p>
    <p className="small" aria-label="Application health counts">Application: {count('healthy')} healthy · {count('degraded')} degraded · {count('unavailable')} unavailable · {count('unknown')} unknown</p>
    <p className="small muted">Data stores: infrastructure health only.</p>
    {notes.length > 0 && <ul className="affected">{notes.map(([key, v]) => <li key={key}>
      <button onClick={() => onPick(key)} style={{ borderColor: v.affected?.color ?? v.color }}>
        <b>{key.split('/')[1]}</b> <span>{v.affected?.label ?? `Telemetry ${label(v.availability)}`}</span>
      </button>
    </li>)}</ul>}
    <details><summary>Service measurements</summary><table className="flows"><thead><tr><th>Service</th><th>req/s</th><th>p95</th></tr></thead>
      <tbody>{rows.map(([key, v]) => <tr key={key}>
        <td><button className="link" onClick={() => onPick(key)}>{key.split('/')[1]}</button><small>{label(v.availability)}</small></td>
        <td>{numberText(v.metrics?.requests_per_second, 2)}</td><td>{latencyText(v.metrics?.p95_latency_ms)}</td>
      </tr>)}</tbody></table></details>
    </details>
  </section>
}

/** Describe observed state without claiming a dependency is a root cause. */
export function LiveIncidentBanner({ deployments, views, onPick }: {
  deployments: K8sObject[]; views: Record<string, LiveServiceView>; onPick: (key: string) => void
}) {
  const affected = deployments.filter((d) => views[keyOf(d)]?.affected)
    .sort((a, b) => views[keyOf(b)].affected!.rank - views[keyOf(a)].affected!.rank)
  const dep = affected[0]
  if (!dep) return null
  const view = views[keyOf(dep)]
  return <div className="hud banner" role="status">
    <b>{dep.metadata.name}: {view.affected!.label}.</b> Application {label(view.application).toLowerCase()} · infrastructure {label(view.infrastructure).toLowerCase()}.
    {' '}<button className="link" onClick={() => onPick(keyOf(dep))}>Inspect →</button>
    {affected.length > 1 && <span className="muted"> (+{affected.length - 1} more)</span>}
  </div>
}
