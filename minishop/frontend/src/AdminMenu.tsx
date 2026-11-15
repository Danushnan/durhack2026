import {useEffect, useRef, useState} from 'react';
import './admin.css';

type Status = {
  traffic: {running:boolean; attempted:number; failed:number; refused?:number; checkouts:number; last_status:number|null; error:string|null};
  operation: {action:string; status:'running'|'succeeded'|'failed'; message:string}|null;
  verified: {delay_ms:number; rejection:boolean; payment_ready:boolean; checkout_ready:boolean; checkout_replicas:number; checked_at:number}|null;
  namespace:string; context:string;
};
const cityUrl = import.meta.env.VITE_KUEBEC_URL || 'http://127.0.0.1:5173';

const packetPresets = [
  { label: 'Send a single request', count: 1, cross_district: false },
  { label: 'Send 5 requests', count: 5, cross_district: false },
  { label: 'Send 1 cross-district request', count: 1, cross_district: true },
  { label: 'Send 5 cross-district requests', count: 5, cross_district: true },
  { label: 'Send 100 requests', count: 100, cross_district: false },
];

export function AdminMenu() {
  const [status,setStatus] = useState<Status>();
  const [busy,setBusy] = useState(false);
  const [message,setMessage] = useState('Connecting to the local operator server…');
  const [error,setError] = useState('');
  const [connectionError,setConnectionError] = useState('');
  const [rate,setRate] = useState('1');
  const [replicas,setReplicas] = useState('1');
  const lock = useRef(false);
  const running = busy || status?.operation?.status === 'running';

  async function request<T = Status>(path:string, method='GET', body?:unknown):Promise<T> {
    const response = await fetch(`/api/demo/${path}`, {method, headers:{'Content-Type':'application/json'},
      body:body === undefined ? undefined : JSON.stringify(body), signal:AbortSignal.timeout(10000)});
    const result = await response.json().catch(()=>null);
    if(!response.ok) throw new Error(typeof result?.detail === 'string' ? result.detail : `Operation unavailable (HTTP ${response.status}). Check the local operator server.`);
    return result;
  }
  useEffect(()=>{
    let cancelled=false;
    async function poll(){try{const value=await request('status');if(!cancelled){setStatus(value);setConnectionError('');setMessage(current=>current.startsWith('Connecting')?'Connected to the local operator server.':current);}}catch(e){if(!cancelled){setConnectionError((e as Error).message);setStatus(undefined);}}}
    void poll();const timer=setInterval(()=>void poll(),2000);
    return()=>{cancelled=true;clearInterval(timer);};
  },[]);

  async function run(path:string, body?:unknown) {
    if(lock.current)return;
    lock.current=true;setBusy(true);setError('');setMessage('Submitting operation…');
    try {
      const result = await request<{ sent?: number }>(path,'POST',body);
      setStatus(await request('status'));
      if (path === 'packets') setMessage(`Queued ${result.sent} ${result.sent === 1 ? 'vehicle' : 'vehicles'} on the Kuebec map.`);
      else if (path === 'packets/reset') setMessage('Demo vehicles and routes cleared.');
      else setMessage(path==='actions'?'Operation submitted. Follow its verified outcome below.':path.endsWith('stop')?'Traffic stopped. An in-flight request may already have reached MiniShop.':'Traffic job acknowledged. Watch the real request counters below.');
    } catch(e){setError((e as Error).message);setMessage('');}
    finally{lock.current=false;setBusy(false);}
  }
  const action=(name:string, extra={})=>void run('actions',{action:name,...extra});
  const fault=status?.verified;
  return <div className="operator">
    <header className="operator-header"><a href="#/" className="operator-brand">mini<span>shop.</span></a><span>DurHack 2026 / operator desk</span><a href={cityUrl} target="_blank" rel="noreferrer">Open KubeVerse ↗</a></header>
    <main className="operator-main">
      <div className="operator-intro"><p className="operator-eyebrow">Live demonstration</p><h1>Demo Control Centre</h1><p>Generate activity in MiniShop. Observe its real dependencies and behaviour in KubeVerse.</p></div>
      <div className="operator-feedback" aria-live="polite"><p>{message}</p>{(connectionError||error)&&<p role="alert" className="operator-error">{connectionError||error}</p>}
        {status?.operation&&<p className={status.operation.status==='failed'?'operator-error':''}><strong>{status.operation.action} · {status.operation.status}</strong> — {status.operation.message}</p>}
      </div>
      <div className="operator-grid">
        <section className="operator-card"><h2>Map traffic presets</h2>
          <p>Open Kuebec alongside this panel. These presets send illustrated packets to the map. Cross-district packets travel by lorry.</p>
          <div className="operator-buttons">
            {packetPresets.map(({ label, ...preset }) => <button key={label} disabled={!status || busy}
              onClick={() => void run('packets', preset)}>{label}</button>)}
            <button disabled title="This preset is not implemented">Overload requests to 1 API</button>
            <button className="secondary" disabled={!status || busy} onClick={() => void run('packets/reset')}>Reset map traffic</button>
          </div>
        </section>
        <section className="operator-card"><span className="operator-step">01 / Activity</span><h2>Traffic generation</h2><p>Real product browsing, baskets and checkout. One worker; at most 300 requests, 20 checkout attempts and five minutes per run.</p>
          <label htmlFor="traffic-rate">Maximum storefront requests per second</label><select id="traffic-rate" value={rate} onChange={e=>setRate(e.target.value)}><option value="0.2">Gentle · 0.2/s</option><option value="1">Presentation · 1/s</option><option value="2">Busy · 2/s</option><option value="20">20/s</option></select>
          <div className="operator-buttons"><button disabled={!status||running||status.traffic.running} onClick={()=>void run('traffic/start',{rps:Number(rate),requests:100})}>Start traffic</button><button className="secondary" disabled={!status||busy} onClick={()=>void run('traffic/stop')}>Stop traffic</button></div>
          <dl className="operator-counters"><div><dt>Status</dt><dd>{status?status.traffic.running?'Running':'Stopped':'Unknown'}</dd></div><div><dt>Attempted</dt><dd>{status?.traffic.attempted??'—'}</dd></div><div><dt>Unsuccessful</dt><dd>{status?.traffic.failed??'—'}</dd></div><div><dt>Verified pod refusals</dt><dd>{status?.traffic.refused??'—'}</dd></div></dl>
          <p className="operator-note">Unsuccessful counts failed storefront attempts, including HTTP 402 declines, other HTTP errors and communication failures. Verified pod refusals is the subset checked after a network/gateway failure with zero Ready pods on a serving workload; it does not identify every failure’s cause. Checkout attempts: {status?.traffic.checkouts??'—'}. Last HTTP status: {status?.traffic.last_status??'—'}.</p>
          {status?.traffic.error&&<p role="alert" className="operator-error">{status.traffic.error}</p>}
        </section>
        <section className="operator-card"><span className="operator-step">02 / Experiments</span><h2>Payments</h2><p>Change the real payment Deployment configuration. Success is shown only after rollout and configuration verification.</p>
          <h3>Latency</h3><p>Verified delay: <strong>{fault?`${fault.delay_ms} ms`:'Not checked'}</strong></p>
          <div className="operator-buttons"><button disabled={!status||running} onClick={()=>action('slowdown')}>Introduce 2,000 ms delay</button><button className="secondary" disabled={!status||running} onClick={()=>action('restore-delay')}>Restore normal delay</button></div>
          <p className="operator-note">The delay adds two seconds to payment processing. A successful payment still completes, and KubeVerse shows it as slow traffic.</p>
          <h3>Test-payment rejection</h3><p>Verified setting: <strong>{fault?fault.rejection?'Rejections enabled':'Accepting payments':'Not checked'}</strong>. A declined checkout returns HTTP 402.</p>
          <div className="operator-buttons"><button className="secondary" disabled={!status||running} onClick={()=>action('reject')}>Enable rejection</button><button className="secondary" disabled={!status||running} onClick={()=>action('accept')}>Disable rejection</button></div>
          <p className="operator-note">To see the explosion and red return in KubeVerse, enable rejection, wait for rollout verification, then run a checkout or start storefront traffic.</p>
        </section>
        <section className="operator-card"><span className="operator-step">03 / Kubernetes</span><h2>Checkout replicas</h2><p>Only <code>minishop/checkout-api</code> can be scaled, from one to three replicas. No arbitrary commands or namespaces.</p>
          <label htmlFor="checkout-replicas">Desired replicas</label><select id="checkout-replicas" value={replicas} onChange={e=>setReplicas(e.target.value)}>{[1,2,3].map(n=><option key={n} value={n}>{n}</option>)}</select>
          <button disabled={!status||running} onClick={()=>action('scale',{replicas:Number(replicas)})}>Apply replica count</button>
          <p className="operator-note">Verified replicas: {fault?.checkout_replicas??'Not checked'}. Pod deletion is not exposed in this panel.</p>
        </section>
        <section className="operator-card"><span className="operator-step">04 / Restore</span><h2>System & demo status</h2><p>Namespace: <strong>{status?.namespace??'Not connected'}</strong><br/>Context: <strong>{status?.context??'Not connected'}</strong></p>
          <p>Payments ready: {fault?String(fault.payment_ready):'Unknown'} · Checkout ready: {fault?String(fault.checkout_ready):'Unknown'}</p>
          <p className="operator-note">Last verification: {fault?new Date(fault.checked_at*1000).toLocaleTimeString():'None'}. These settings are a readback, not a continuous health feed. Use KubeVerse for current health.</p>
          <div className="operator-buttons"><button className="secondary" disabled={!status||running} onClick={()=>action('inspect')}>Refresh verified settings</button><button disabled={!status||running} onClick={()=>action('reset')}>Reset demo configuration</button></div>
          <p className="operator-note">Reset stops traffic, restores 100 ms payments, disables rejection and scales Checkout to one. Orders, baskets and databases are retained. Discovery reset remains separate in KubeVerse.</p>
        </section>
      </div>
      <footer><a href="#/">← Back to MiniShop</a><p>Local operator controls · disabled unless explicitly configured</p></footer>
    </main>
  </div>;
}
