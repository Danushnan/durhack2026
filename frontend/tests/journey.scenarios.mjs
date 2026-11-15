// Opt-in: creates demo basket mutations against the isolated local servers.
const {chromium} = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright')
import assert from 'node:assert/strict'
const browser=await chromium.launch({...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {}),headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--enable-unsafe-swiftshader']})
async function viewer(){
 const context=await browser.newContext({viewport:{width:1280,height:900}})
 const city=await context.newPage(), reports=[]
 city.on('response',async r=>{if(r.url().includes('/api/journeys/')&&r.ok())try{reports.push(await r.json())}catch{}})
 await city.goto('http://127.0.0.1:5181'); await city.getByRole('button',{name:'Journey',exact:true}).click({timeout:40000})
 await city.getByLabel('MiniShop URL').fill('http://127.0.0.1:5182')
 const popup=city.waitForEvent('popup');await city.getByRole('button',{name:'Open paired MiniShop'}).click();const shop=await popup
 await shop.getByRole('button',{name:'Add to basket',exact:true}).first().waitFor({timeout:20000})
 return {context,city,shop,reports}
}
async function waitFor(check){for(let i=0;i<80;i++){if(check())return;await new Promise(r=>setTimeout(r,500))}throw new Error('Expected journey outcome unavailable')}
try{
 const a=await viewer(),b=await viewer();console.log('two independent viewers paired')
 await Promise.all([a.shop.getByRole('button',{name:'Add to basket',exact:true}).first().click(),b.shop.getByRole('button',{name:'Add to basket',exact:true}).first().click()])
 await a.shop.evaluate(()=>fetch('/api/products',{headers:{'X-Request-ID':crypto.randomUUID()}}))
 await waitFor(()=>a.reports.some(r=>r.state==='complete')&&b.reports.some(r=>r.state==='complete'))
 const one=a.reports.findLast(r=>r.state==='complete'),two=b.reports.findLast(r=>r.state==='complete')
 assert.notEqual(one.action_id,two.action_id)
 assert.ok(one.events.every(e=>!two.events.some(other=>other.request_id===e.request_id)))
 console.log('concurrent actions isolated; unrelated catalogue traffic excluded')
 // Genuine successful mutation, then a browser-side refresh failure (no invented backend GET event).
 await a.shop.route('**/api/carts/*',r=>r.request().method()==='GET'?r.abort():r.continue())
 await a.shop.getByRole('button',{name:'Add to basket',exact:true}).first().click()
 await waitFor(()=>a.reports.some(r=>r.action_id!==one.action_id&&r.mutation_accepted&&r.browser.refresh==='failed'))
 const refreshFailure=a.reports.findLast(r=>r.action_id!==one.action_id&&r.mutation_accepted&&r.browser.refresh==='failed')
 assert.equal(refreshFailure.state,'failed');assert.equal(refreshFailure.steps[5].event_ids.length,0)
 console.log('accepted mutation plus failed browser refresh correctly separated')
 await a.shop.unroute('**/api/carts/*')
 // Real backend request rejection; quantity validation rejects the POST and no GET is sent.
 await a.shop.route('**/api/carts/*/items',r=>{const body=JSON.parse(r.request().postData());r.continue({postData:JSON.stringify({...body,quantity:100})})})
 await a.shop.getByRole('button',{name:'Add to basket',exact:true}).first().click()
 await waitFor(()=>a.reports.some(r=>r.browser.mutation==='failed'&&r.browser.refresh==='not_sent'&&r.events.some(e=>e.event==='http_server'&&e.status===422)))
 const rejected=a.reports.findLast(r=>r.browser.mutation==='failed'&&r.browser.refresh==='not_sent')
 assert.equal(rejected.mutation_accepted,false)
 console.log('actual HTTP 422 rejection observed; refresh not sent; no mutation-success claim')
 console.log('SCENARIOS PASSED')
}finally{await browser.close()}
