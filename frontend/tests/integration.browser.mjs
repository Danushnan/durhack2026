// Isolated production-build smoke test. HTTP/WS and shopping evidence are mocked;
// no cluster, application backend or database is contacted.
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {readFile} from 'node:fs/promises'
import {execFileSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {snapshot} from './liveMetrics.fixture.ts'
const {chromium} = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright')
const fixtures=JSON.parse(execFileSync(process.env.TEST_PYTHON ?? 'python3',[fileURLToPath(new URL('./integration-fixtures.py',import.meta.url))],{encoding:'utf8'}))
const root=new URL('../dist/',import.meta.url)
const server=createServer(async(req,res)=>{
 try {
  if(req.url.startsWith('/mock-shop')){
   res.setHeader('Content-Type','text/html');res.end(`<button id="basket">Basket</button><button id="checkout">Checkout</button><button id="decline">Decline</button><script>const actions=${JSON.stringify(fixtures.map(f=>f.action))};['basket','checkout','decline'].forEach((id,i)=>document.getElementById(id).onclick=()=>{const action={...actions[i]};if(action.kind==='checkout'){action.checkout='pending';delete action.basket_cleared}else{action.mutation='pending';action.refresh='pending'}opener.postMessage({type:'kubeverse:basket-action',action},location.origin);setTimeout(()=>opener.postMessage({type:'kubeverse:basket-action',action:actions[i]},location.origin),300)});</script>`);return
  }
  const path=req.url.split('?')[0]; const file=new URL(path==='/'?'index.html':path.slice(1),root)
  if(!file.href.startsWith(root.href)){res.writeHead(403);res.end();return}
  res.setHeader('Content-Type',file.pathname.endsWith('.js')?'text/javascript':file.pathname.endsWith('.css')?'text/css':'text/html')
  res.end(await readFile(file))
 }catch{res.writeHead(404);res.end()}
})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const base=`http://127.0.0.1:${server.address().port}`
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH,headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--enable-unsafe-swiftshader']})
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[]
 page.setDefaultTimeout(15000)
 page.on('pageerror',e=>errors.push(e.message))
 let socket,context='kind-minishop',connections=0,posts=0
 const initialTime=Date.now()
 const edge={from:'minishop/checkout-api',to:'minishop/payment-api',requests:5,rps:1,healthy:true,error_rate:1,refused_rate:0,latency_ms:2000}
 const other={...edge,from:'minishop/minishop-web',to:'minishop/cart-api',error_rate:0}
 function metrics(){
  const m=snapshot();const at=new Date(Date.now()).toISOString()
  m.context=context;m.source_id=`kubernetes:${context}:minishop`;m.observed_at=at;m.window={start:new Date(Date.now()-10000).toISOString(),end:at,seconds:10}
  m.source.last_resource_refresh_at=at;m.source.last_log_poll_at=at;m.source.last_application_event_at=at
  return m
 }
 function tick(){socket?.send(JSON.stringify([{type:'HEALTH',stale:false,lastRefresh:Date.now()}, {type:'TRAFFIC',edges:[edge,other]},metrics()]))}
 await page.routeWebSocket('**/ws?telemetry=1',ws=>{
  socket=ws;connections++
  ws.send(JSON.stringify([{type:'SOURCE',context}, ...metrics().services.map(s=>({type:'ADDED',object:{kind:'Deployment',metadata:{namespace:'minishop',name:s.service.split('/')[1],uid:s.deployment_uid},spec:{replicas:1},status:{readyReplicas:1}}}))]))
  tick()
 })
 await page.route('**/api/journeys/**',async route=>{
  const req=route.request();if(req.method()==='POST')posts++
  const id=req.method()==='POST'?req.postDataJSON().action_id:req.url().split('/').at(-1)
  const f=fixtures.find(f=>f.action.action_id===id);assert.ok(f)
  await route.fulfill({json:f.result})
 })
 const interval=setInterval(tick,500)
 try{
  await page.goto(base);console.log('city opened')
  await page.getByRole('complementary',{name:'Discovery recent activity'}).waitFor()
  await page.getByRole('button',{name:/Checkout → Payment/}).waitFor({timeout:20000})
  console.log('Discovery armed');await page.getByRole('button',{name:/Checkout → Payment/}).click()
  await page.getByRole('region',{name:'Selected connection'}).waitFor()
  socket.send(JSON.stringify([{type:'DEMO_REFUSAL',context,source:other.from,target:other.to}]))
  if(process.env.CAPTURE_SCREENSHOTS)await page.screenshot({path:'/tmp/durhack-integration-discovery.png'})
  await page.getByRole('button',{name:'Clear highlight'}).click()
  await page.getByRole('button',{name:'Journey',exact:true}).click()
  await page.getByLabel('MiniShop URL').fill(`${base}/mock-shop`)
  const popup=page.waitForEvent('popup');await page.getByRole('button',{name:'Open paired MiniShop'}).click();const shop=await popup
  const panel=page.getByRole('complementary',{name:'Guided shopping journey'})
  for(const [button,index] of [['Basket',0],['Checkout',1],['Decline',2]]){
   console.log('Journey action',button);await shop.getByRole('button',{name:button,exact:true}).click()
   await panel.getByText(fixtures[index].result.steps[0].heading,{exact:true}).waitFor()
   for(const text of ['What’s happening?','Why this component?','Why does it matter?'])assert.ok(await panel.getByText(text,{exact:true}).isVisible())
   await page.getByLabel('Guide speed').selectOption('0.25');assert.equal(await page.getByLabel('Guide speed').inputValue(),'0.25')
   await page.getByLabel('Guide speed').selectOption('1')
   for(let i=0;i<4;i++)await page.getByRole('button',{name:'Next',exact:true}).click()
   if(index===2)await panel.getByText(/HTTP 402/).first().waitFor()
   const before=posts;await page.getByRole('button',{name:'Replay guide'}).click();assert.equal(posts,before)
   if(process.env.CAPTURE_SCREENSHOTS)await page.screenshot({path:`/tmp/durhack-integration-journey-${index}.png`})
  }
  const canvas=await page.locator('canvas').elementHandle()
  await page.getByRole('button',{name:'Traffic',exact:true}).click()
  await page.getByRole('button',{name:'Reset Discovery',exact:true}).click()
  assert.equal(await page.getByRole('region',{name:'Selected connection'}).count(),0)
  console.log('Reconnect');socket.close();
  await page.waitForTimeout(1500);assert.ok(connections>=2)
  context='other-source';socket.send(JSON.stringify([{type:'SOURCE',context}, ...metrics().services.map(s=>({type:'ADDED',object:{kind:'Deployment',metadata:{namespace:'minishop',name:s.service.split('/')[1],uid:s.deployment_uid},spec:{replicas:1},status:{readyReplicas:1}}}))]));tick()
  await page.getByRole('button',{name:'Journey',exact:true}).click()
  await panel.getByText('Waiting for a paired shopping action.').waitFor()
  assert.ok(await canvas.evaluate(c=>c.isConnected))
  for(const width of [320,768,1024,1440]){
   await page.setViewportSize({width,height:900})
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
  }
  assert.deepEqual(errors,[])
  console.log(JSON.stringify({passed:true,posts,connections,elapsedMs:Date.now()-initialTime,errors}))
 }finally{clearInterval(interval)}
}finally{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
