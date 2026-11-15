// Opt-in: creates one simulated order through the existing Kubernetes MiniShop.
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright')
import assert from 'node:assert/strict'
import {writeFileSync} from 'node:fs'
const browser=await chromium.launch({...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{}),headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--enable-unsafe-swiftshader']})
try{
 const context=await browser.newContext({viewport:{width:1440,height:1000}})
 const city=await context.newPage(),reports=[],errors=[]
 city.setDefaultTimeout(15000);city.on('pageerror',e=>errors.push(e.message))
 city.on('response',async r=>{if(r.url().includes('/api/journeys/')&&r.ok())try{reports.push(await r.json())}catch{}})
 await city.goto('http://127.0.0.1:5181')
 await city.getByRole('button',{name:'Journey',exact:true}).click({timeout:25000})
 await city.getByLabel('MiniShop URL').fill('http://127.0.0.1:5182')
 const popup=city.waitForEvent('popup');await city.getByRole('button',{name:'Open paired MiniShop'}).click();const shop=await popup
 shop.on('pageerror',e=>errors.push(e.message))
 await shop.getByRole('button',{name:'Add to basket',exact:true}).first().click({timeout:25000})
 await city.getByRole('status').filter({hasText:'complete'}).waitFor({timeout:35000})
 // The three educational questions are visible without opening technical logs.
 const panel=city.getByRole('complementary',{name:'Guided shopping journey'})
 for(const name of ['What’s happening?','Why this component?','Why does it matter?'])assert.ok(await panel.getByText(name,{exact:true}).isVisible())
 await shop.getByRole('link',{name:/Basket, \d+ items/}).click()
 await shop.getByRole('button',{name:/Review checkout/}).click()
 const checkoutRequests=[]
 shop.on('request',r=>{if(r.url().includes('/api/checkout/'))checkoutRequests.push(r)})
 await shop.getByRole('button',{name:/Place demo order/}).click()
 await shop.getByRole('heading',{name:'A good choice.'}).waitFor({timeout:30000})
 for(let i=0;i<90&&!reports.some(r=>r.kind==='checkout'&&r.order_confirmed&&r.browser.checkout==='succeeded');i++)await new Promise(r=>setTimeout(r,500))
 const result=reports.findLast(r=>r.kind==='checkout'&&r.order_confirmed&&r.browser.checkout==='succeeded')
 assert.ok(result,'Checkout root and browser confirmation must both be captured')
 assert.equal(checkoutRequests.length,1)
 assert.equal(new Set(result.events.map(e=>e.request_id)).size,1)
 assert.ok(result.events.some(e=>e.operation==='orders.transaction'))
 assert.ok(result.events.some(e=>e.operation==='basket.freeze'))
 assert.ok(result.events.some(e=>e.target==='minishop/payment-api'))
 for(let i=0;i<4;i++)await city.getByRole('button',{name:'Next',exact:true}).click()
 await panel.getByText('Ask for a simulated payment',{exact:true}).waitFor()
 assert.ok(result.payment_duration_ms>=0)
 await panel.locator('details').filter({has:city.getByText('Actual request and event details',{exact:true})}).locator('summary').click()
 const canvas=await city.locator('canvas').first().elementHandle()
 await city.getByRole('button',{name:'Replay guide'}).click()
 await city.getByRole('button',{name:'Traffic',exact:true}).click();await city.getByRole('button',{name:'Journey',exact:true}).click()
 assert.equal(checkoutRequests.length,1,'Playback must not create another order')
 assert.ok(await canvas.evaluate(c=>c.isConnected))
 await city.screenshot({path:'/tmp/kubeverse-checkout-education.png'})
 assert.deepEqual(errors,[])
 writeFileSync('/tmp/kubeverse-checkout-browser.json',JSON.stringify({result,checkoutRequests:checkoutRequests.length,errors},null,2))
 console.log(JSON.stringify({kind:result.kind,state:result.state,orderConfirmed:result.order_confirmed,events:result.events.length,paymentMs:result.payment_duration_ms,checkoutRequests:checkoutRequests.length,errors}))
}finally{await browser.close()}
