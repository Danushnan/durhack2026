import {useEffect, useRef, useState} from 'react';
import './admin.css';

type Status = {
  traffic: {running:boolean; attempted:number; failed:number; checkouts:number; last_status:number|null; error:string|null};
  operation: {action:string; status:'running'|'succeeded'|'failed'; message:string}|null;
  verified: {delay_ms:number; rejection:boolean; payment_ready:boolean; checkout_ready:boolean; checkout_replicas:number; checked_at:number}|null;
  namespace:string; context:string;
};
const cityUrl = import.meta.env.VITE_KUEBEC_URL || 'http://127.0.0.1:5173';

export function AdminMenu() {
  // Operator credentials stay in memory only; never in URLs, localStorage or the bundle.
  const [token,setToken] = useState('');
  const [draft,setDraft] = useState('');
  const [status,setStatus] = useState<Status>();
  const [busy,setBusy] = useState(false);
  const [message,setMessage] = useState('Enter the token configured on the local operator server.');
  const [error,setError] = useState('');
  const [rate,setRate] = useState('1');
  const [replicas,setReplicas] = useState('1');
  const lock = useRef(false);
  const running = busy || status?.operation?.status === 'running';

  async function request(path:string, method='GET', body?:unknown, secret=token):Promise<Status> {
    const response = await fetch(`/api/demo/${path}`, {method, headers:{Authorization:`Bearer ${secret}`,'Content-Type':'application/json'},
      body:body === undefined ? undefined : JSON.stringify(body), signal:AbortSignal.timeout(10000)});
    const result = await response.json().catch(()=>null);
    if(!response.ok) throw new Error(typeof result?.detail === 'string' ? result.detail : `Operation unavailable (HTTP ${response.status}). Check the local operator server.`);
    return result;
  }
  useEffect(()=>{
    if(!token)return;
    let cancelled=false;
    async function poll(){try{const value=await request('status');if(!cancelled){setStatus(value);setError('');setMessage(current=>current.startsWith('Connecting')?'Connected to the local operator server.':current);}}catch(e){if(!cancelled){setError((e as Error).message);setStatus(undefined);}}}
    void poll();const timer=setInterval(()=>void poll(),2000);
    return()=>{cancelled=true;clearInterval(timer);};
  },[token]);

  async function run(path:string, body?:unknown) {
    if(lock.current)return;
    lock.current=true;setBusy(true);setError('');setMessage('Submitting operation…');
    try {
      await request(path,'POST',body);
      setStatus(await request('status'));
      setMessage(path==='actions'?'Operation submitted. Follow its verified outcome below.':path.endsWith('stop')?'Traffic stopped. An in-flight request may already have reached MiniShop.':'Traffic job acknowledged. Watch the real request counters below.');
    } catch(e){setError((e as Error).message);setMessage('');}
    finally{lock.current=false;setBusy(false);}
  }
  const action=(name:string, extra={})=>void run('actions',{action:name,...extra});
  const fault=status?.verified;
  return <div className="operator">
    <header className="operator-header"><a href="#/" className="operator-brand">mini<span>shop.</span></a><span>DurHack 2026 / operator desk</span><a href={cityUrl} target="_blank" rel="noreferrer">Open KubeVerse ↗</a></header>
    <main className="operator-main">
      <div className="operator-intro"><p className="operator-eyebrow">Live demonstration</p><h1>Demo Control Centre</h1><p>Generate activity in MiniShop. Observe its real dependencies and behaviour in KubeVerse.</p></div>
      <form className="operator-auth" onSubmit={e=>{e.preventDefault();setToken(draft);setStatus(undefined);setMessage('Connecting to the local operator server…');}}>
        <label htmlFor="operator-token">Operator token</label><input id="operator-token" type="password" autoComplete="off" value={draft} onChange={e=>setDraft(e.target.value)} required minLength={24}/><button type="submit">Connect</button>
      </form>
      <div className="operator-feedback" aria-live="polite"><p>{message}</p>{error&&<p role="alert" className="operator-error">{error}</p>}
        {status?.operation&&<p className={status.operation.status==='failed'?'operator-error':''}><strong>{status.operation.action} · {status.operation.status}</strong> — {status.operation.message}</p>}
      </div>
      <div className="operator-grid">
        <section className="operator-card"><span className="operator-step">01 / Activity</span><h2>Traffic generation</h2><p>Real product browsing, baskets and checkout. One worker; at most 300 requests, 20 checkout attempts and five minutes per run.</p>
          <label htmlFor="traffic-rate">Maximum storefront requests per second</label><select id="traffic-rate" value={rate} onChange={e=>setRate(e.target.value)}><option value="0.2">Gentle · 0.2/s</option><option value="1">Presentation · 1/s</option><option value="2">Busy · 2/s</option></select>
          <div className="operator-buttons"><button disabled={!status||running||status.traffic.running} onClick={()=>void run('traffic/start',{rps:Number(rate),requests:100})}>Start traffic</button><button className="secondary" disabled={!status||busy} onClick={()=>void run('traffic/stop')}>Stop traffic</button></div>
          <dl className="operator-counters"><div><dt>Status</dt><dd>{status?status.traffic.running?'Running':'Stopped':'Unknown'}</dd></div><div><dt>Attempted</dt><dd>{status?.traffic.attempted??'—'}</dd></div><div><dt>Unsuccessful</dt><dd>{status?.traffic.failed??'—'}</dd></div></dl>
          <p className="operator-note">Counters count storefront HTTP attempts, not individual traced requests. Unsuccessful includes HTTP 402 and network errors. Checkout attempts: {status?.traffic.checkouts??'—'}. Last HTTP status: {status?.traffic.last_status??'—'}.</p>
          {status?.traffic.error&&<p role="alert" className="operator-error">{status.traffic.error}</p>}
        </section>
        <section className="operator-card"><span className="operator-step">02 / Experiments</span><h2>Payments</h2><p>Change the real payment Deployment configuration. Success is shown only after rollout and configuration verification.</p>
          <h3>Latency</h3><p>Verified delay: <strong>{fault?`${fault.delay_ms} ms`:'Not checked'}</strong></p>
          <div className="operator-buttons"><button disabled={!status||running} onClick={()=>action('slowdown')}>Introduce 2,000 ms delay</button><button className="secondary" disabled={!status||running} onClick={()=>action('restore-delay')}>Restore normal delay</button></div>
          <h3>Test-payment rejection</h3><p>Verified setting: <strong>{fault?fault.rejection?'Rejections enabled':'Accepting payments':'Not checked'}</strong>. A rejection produces HTTP 402 and an unsuccessful checkout, not a crashed pod or HTTP 5xx.</p>
          <div className="operator-buttons"><button className="secondary" disabled={!status||running} onClick={()=>action('reject')}>Enable rejection</button><button className="secondary" disabled={!status||running} onClick={()=>action('accept')}>Disable rejection</button></div>
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
