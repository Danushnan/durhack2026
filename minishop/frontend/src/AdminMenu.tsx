import {useEffect, useRef, useState} from 'react';
import {beginCheckoutAction, reportBasketAction, type CheckoutAction} from './journey';
import './admin.css';

type Measurements = {samples:number; rps:number; incoming_rps:number; average_ms:number|null; p95_ms:number|null; successful:number; failed:number};
type Status = {
  operation:{action:string; status:string; message:string}|null;
  verified:{payment_ready:boolean; checkout_ready:boolean; checkout_replicas:number}|null;
  namespace:string; context:string;
  ambient:{running:boolean; rate:number; sent:number; error:string|null};
  scenario:{request_id?:string; active:'order'|'failure'|'rush'|null; phase:string; message:string; steps:{label:string;status:number;ms:number}[]; result:Record<string,unknown>|null};
  rush:Measurements & {target_rps:number; elapsed:number; scaled:boolean; running:boolean; sent:number; skipped:number; before:Measurements|null; comparison:string};
};
const cityUrl = import.meta.env.VITE_KUEBEC_URL || 'http://127.0.0.1:5173';
const ms = (value:number|null|undefined) => value == null ? '—' : `${value} ms`;

export function AdminMenu() {
  const [status,setStatus] = useState<Status>();
  const [error,setError] = useState('');
  const [connectionError,setConnectionError] = useState('');
  const [busy,setBusy] = useState(false);
  const [ambientRate,setAmbientRate] = useState('1');
  const [ambientBusy,setAmbientBusy] = useState(false);
  const ambientLock = useRef(false);
  const lock = useRef(false);
  const journey = useRef<CheckoutAction|null>(null);
  const registered = useRef(false);
  const active = status?.scenario.active;
  const working = busy || status?.operation?.status === 'running';
  const rush = status?.rush;
  async function request(path:string, body?:unknown):Promise<Status> {
    const response = await fetch(`/api/demo/${path}`, {method:body?'POST':'GET',
      headers:{'Content-Type':'application/json'}, body:body?JSON.stringify(body):undefined,
      signal:AbortSignal.timeout(10000)});
    const value = await response.json();
    if(!response.ok) throw new Error(typeof value.detail === 'string'?value.detail:`Operator unavailable (${response.status})`);
    return value;
  }
  useEffect(()=>{
    let cancelled=false;
    const poll=async()=>{try{const value=await request('status');if(!cancelled){setStatus(value);setConnectionError('');}}catch(e){if(!cancelled){setStatus(undefined);setConnectionError((e as Error).message);}}};
    void poll();const timer=setInterval(()=>void poll(),1000);
    return()=>{cancelled=true;clearInterval(timer);};
  },[]);
  useEffect(()=>{
    if(!status || !journey.current || status.scenario.request_id !== journey.current.request_id) return;
    if(status.scenario.phase==='requesting' && !registered.current) {registered.current=true;void beginCheckoutAction(journey.current);}
    if(status.operation?.status==='running') return;
    const action=journey.current;
    const success=status.scenario.active==='order' && status.scenario.phase==='completed';
    reportBasketAction({...action,checkout:success?'succeeded':'failed',
      ...(success?{basket_cleared:status.scenario.result?.basket_cleared === true}:{})});
    journey.current=null;
  },[status]);
  async function run(action:string) {
    if(lock.current)return;
    lock.current=true;setBusy(true);setError('');
    try {
      let request_id: string|undefined;
      if(action==='order'||action==='failure') {
        registered.current=false;
        journey.current={kind:'checkout',action_id:crypto.randomUUID(),request_id:crypto.randomUUID(),checkout:'pending'};
        request_id=journey.current.request_id;
      }
      await request('scenario',{action,...(request_id?{request_id}:{})});
      setStatus(await request('status'));
    } catch(e){setError((e as Error).message);if(journey.current){reportBasketAction({...journey.current,checkout:'failed'});journey.current=null;}}
    finally{lock.current=false;setBusy(false);}
  }
  async function normalTraffic(enabled:boolean) {
    if(ambientLock.current)return;
    ambientLock.current=true;setAmbientBusy(true);setError('');
    try {await request('ambient',{enabled,rate:Number(ambientRate)});setStatus(await request('status'));}
    catch(e){setError((e as Error).message);}
    finally{ambientLock.current=false;setAmbientBusy(false);}
  }
  const unavailable=!status||working||active==='rush';
  return <div className="operator">
    <header className="operator-header"><a href="#/" className="operator-brand">KubeVerse<span> / demos</span></a><span>{status?`${status.context} · ${status.namespace}`:'Connecting to operator…'}</span><a href={cityUrl} target="_blank" rel="noreferrer">Open city ↗</a></header>
    <main className="operator-main">
      <div className="operator-intro"><p className="operator-eyebrow">Three stories. One living city.</p><h1>Watch the system respond.</h1><p>Keep the city alongside this panel. The three demos use real MiniShop requests and Kubernetes rollouts. Normal traffic adds an illustrative city backdrop.</p></div>
      <div className="operator-feedback" aria-live="polite" aria-busy={working}>
        <p><strong>{working?'Working…':status?`${active?{order:'Follow an Order',failure:'Payment Failure',rush:'Rush Hour'}[active]:'Ready'} · ${status.scenario.phase}`:'Connecting…'}</strong></p>
        <p>{status?.scenario.message}</p>
        {(error||connectionError)&&<p role="alert" className="operator-error">{error||connectionError}</p>}
        {status?.scenario.phase==='failed'&&<p className="operator-error">Demo could not complete. Use Reset below before retrying.</p>}
      </div>
      <section className="operator-card normal-traffic" aria-label="Normal traffic">
        <span className="operator-step">City ambience · illustrative traffic</span><h2>Normal running</h2>
        <p>Watch vehicles travel between random visible buildings, like a city with everyday users.</p>
        <label htmlFor="ambient-rate">Spawn rate · {ambientRate} vehicles / second</label>
        <input id="ambient-rate" type="range" min="0.5" max="5" step="0.5" value={ambientRate} onChange={e=>setAmbientRate(e.target.value)} />
        <div className="operator-buttons"><button disabled={!status||ambientBusy} onClick={()=>void normalTraffic(true)}>{ambientBusy?'Updating…':status?.ambient.running?'Apply rate':'Start normal traffic'}</button>
          <button className="secondary" disabled={!status||ambientBusy||!status.ambient.running} onClick={()=>void normalTraffic(false)}>Turn off normal traffic</button></div>
        <p aria-live="polite"><strong>{status?.ambient.running?'Running':'Off'}</strong>{status?.ambient.running?` · ${status.ambient.rate} vehicles/s`:''} · {status?.ambient.sent??0} vehicles sent</p>
        {status?.ambient.error&&<p role="alert" className="operator-error">{status.ambient.error}</p>}
        <p className="operator-note">Illustrative cars and cross-district lorries only; these do not make real requests or affect health metrics. Open the city in Traffic view. Turning off stops new spawns; vehicles already moving finish their trips. This control runs independently of the demos below.</p>
      </section>
      <div className="operator-grid demo-grid">
        <section className={`operator-card ${active==='order'?'is-active':''}`} aria-label="Follow an Order">
          <span className="operator-step">01 / Normal operation {active==='order'?'· Active':''}</span><h2>Follow an Order</h2>
          <p>Browse a product, fill a basket, and place a real order. Follow Checkout’s measured calls through the city.</p>
          <button disabled={unavailable} onClick={()=>void run('order')}>Place Order</button>
          {active==='order'&&status?.scenario.result&&<p className="demo-outcome">✓ Order confirmed · {String(status.scenario.result.id ?? '')}</p>}
          <p className="operator-note">Payments are simulated; orders are persisted in PostgreSQL. No money is charged.</p>
        </section>
        <section className={`operator-card ${active==='failure'?'is-active':''}`} aria-label="Payment Failure">
          <span className="operator-step">02 / Application failure {active==='failure'?'· Active':''}</span><h2>When payment fails</h2>
          <p>The same checkout meets a rejected payment. Watch the error return while Kubernetes Pods remain Ready.</p>
          <button disabled={unavailable} onClick={()=>void run('failure')}>Simulate Payment Failure</button>
          {active==='failure'&&status?.scenario.phase==='completed'&&<p className="demo-outcome">Payment declined · HTTP 402<br/>No order confirmed. Basket retained.</p>}
          <p className="operator-note">A rejected transaction is an application outcome. Payment acceptance is restored after the attempt.</p>
        </section>
        <section className={`operator-card rush-card ${active==='rush'?'is-active':''}`} aria-label="Rush Hour">
          <span className="operator-step">03 / Main showcase {active==='rush'?'· Active':''}</span><h2>Can our city handle the traffic?</h2>
          <p>Six customers per second compete for one Checkout Pod. Scale to three replicas and compare real response times under the same requested load.</p>
          <div className="operator-buttons">
            <button disabled={unavailable} onClick={()=>void run('rush')}>Start Rush Hour</button>
            {active==='rush'&&<button disabled={!status||working||!rush?.running||rush.scaled||rush.elapsed<10} onClick={()=>void run('scale')}>{rush?.scaled?'Scaled to 3 replicas':'Scale Up → 3 replicas'}</button>}
          </div>
          {active==='rush'&&rush&&<>
            <dl className="operator-counters"><div><dt>Customers sent / s</dt><dd>{rush.incoming_rps}</dd></div><div><dt>Completed / s</dt><dd>{rush.rps}</dd></div><div><dt>Average</dt><dd>{ms(rush.average_ms)}</dd></div><div><dt>p95</dt><dd>{ms(rush.p95_ms)}</dd></div><div><dt>Success / failed</dt><dd>{rush.successful} / {rush.failed}</dd></div><div><dt>Verified replicas</dt><dd>{status?.verified?.checkout_replicas??'—'}</dd></div></dl>
            {rush.before&&<p>Before scaling: {ms(rush.before.average_ms)} average · {ms(rush.before.p95_ms)} p95 · {rush.before.incoming_rps} customers/s. {rush.comparison}</p>}
            <p className="operator-note">{rush.running?'Load running':'Load stopped'} · Target {rush.target_rps}/s · {rush.sent} customers sent · {rush.skipped} skipped at the concurrency limit. Metrics cover completed attempts in the last 10 seconds, excluding responses completed before the scale rollout finished. Failed attempts before Checkout use total customer duration.</p>
          </>}
          <p className="operator-note">Demo-only capacity: two processing slots per Pod, 600 ms work per checkout, and a two-second queue timeout (HTTP 429). Health probes bypass the queue. Load is capped at 24 concurrent customers and three minutes.</p>
        </section>
      </div>
      {status?.scenario.steps.length ? <section className="demo-journey" aria-label="Observed storefront requests"><h2>Request journey</h2><ol>{status.scenario.steps.map((s,i)=><li key={i}><strong>{s.label}</strong><span>HTTP {s.status} · {s.ms} ms</span></li>)}</ol><p className="operator-note">These are observed storefront responses. Internal service calls and database operations appear from real logs in the city. For step-by-step highlighting, open this panel at <code>#/admin</code> from the city’s paired Journey View.</p></section>:null}
      <footer><div><button className="secondary" disabled={!status||working} onClick={()=>void run('reset')}>{active==='rush'?'Stop Rush Hour / Reset':'Reset demos'}</button><p className="operator-note">Stops load and restores the pre-rush replica count and capacity settings. Restores normal payments. Orders and baskets are retained.</p></div><p>{status?.verified?`Last readback: Payments ${status.verified.payment_ready?'Ready':'not Ready'} · Checkout ${status.verified.checkout_ready?'Ready':'not Ready'}`:'Configuration not yet verified'}<br/><a href="#/">Back to MiniShop</a></p></footer>
    </main>
  </div>;
}
