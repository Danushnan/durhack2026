// Opt-in: creates demo basket mutations against the isolated local servers.
const {chromium} = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright')
import assert from 'node:assert/strict'
import {writeFileSync} from 'node:fs'
const browser=await chromium.launch({...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {}),headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--enable-unsafe-swiftshader'],timeout:20000})
const errors=[]
try {
  const context=await browser.newContext({viewport:{width:1440,height:1000}})
  const page=await context.newPage()
  page.setDefaultTimeout(10000)
  console.log('city open')
  page.on('pageerror',e=>errors.push(e.message))
  const reports=[]
  page.on('response',async r=>{if(r.url().includes('/api/journeys/')&&r.ok())try{reports.push(await r.json())}catch{}})
  await page.goto('http://127.0.0.1:5181')
  await page.getByRole('button',{name:'Journey',exact:true}).click({timeout:20000})
  assert.equal(await page.getByRole('button',{name:'Architecture',exact:true}).count(),0)
  await page.getByLabel('MiniShop URL').fill('http://127.0.0.1:5182')
  const opened=page.waitForEvent('popup')
  await page.getByRole('button',{name:'Open paired MiniShop'}).click()
  const shop=await opened
  console.log('shop paired')
  shop.on('pageerror',e=>errors.push(e.message))
  await shop.getByRole('button',{name:'Add to basket',exact:true}).first().waitFor({timeout:20000})
  const requests=[]
  shop.on('request',r=>{if(/\/api\/carts\//.test(r.url()))requests.push({method:r.method(),id:r.headers()['x-request-id']})})
  await shop.getByRole('button',{name:'Add to basket',exact:true}).first().click()
  await page.getByRole('status').filter({hasText:'complete'}).waitFor({timeout:40000})
  console.log('complete observed')
  const result=reports.findLast(r=>r.state==='complete')
  assert.ok(result)
  assert.equal(requests.length,2)
  assert.equal(new Set(requests.map(r=>r.id)).size,2)
  assert.equal(new Set(result.events.map(e=>e.request_id)).size,2)
  assert.ok(result.mutation_accepted)
  assert.ok(result.events.some(e=>e.operation==='products.select_one'))
  assert.ok(result.events.some(e=>e.operation==='basket.mutate'))
  assert.ok(result.events.some(e=>e.operation==='basket.get'))
  for(let i=0;i<8;i++){console.log('advance',i);await page.getByRole('button',{name:'Next',exact:true}).click()}
  await page.getByText('The browser reports that it updated the displayed basket.').waitFor()
  await page.getByRole('button',{name:'Replay guide'}).click()
  await page.getByRole('button',{name:'Next',exact:true}).click()
  await page.waitForTimeout(800)
  await page.screenshot({path:'/tmp/kubeverse-journey-desktop.png'})
  assert.equal(requests.length,2,'Replay must not resend HTTP operations')
  // Camera controls and retained Canvas survive activity mode changes.
  const canvas=await page.locator('canvas').first().elementHandle()
  await page.getByRole('button',{name:'Traffic',exact:true}).click()
  await page.getByRole('button',{name:'Journey',exact:true}).click()
  assert.ok(await canvas.evaluate(c=>c.isConnected))
  await page.getByRole('button',{name:'Switch to the free 3D view'}).click()
  await page.getByRole('button',{name:'Reset the camera to the overview'}).click()
  console.log('camera verified')
  await page.setViewportSize({width:320,height:768})
  await page.getByRole('button',{name:'Reset Discovery',exact:true}).click()
  await page.getByRole('button',{name:'Next',exact:true}).click()
  await page.locator('.journey-panel').evaluate(el => {el.scrollTop=0})
  await page.screenshot({path:'/tmp/kubeverse-journey-mobile.png'})
  for (const width of [768,1024]) {
    await page.setViewportSize({width,height:900})
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
    await page.screenshot({path:`/tmp/kubeverse-journey-${width}.png`})
  }
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
  assert.deepEqual(errors,[])
  writeFileSync('/tmp/kubeverse-journey-evidence.json',JSON.stringify({requests,journey:result,errors},null,2))
  console.log(JSON.stringify({state:result.state,events:result.events.length,requests:requests.length,errors}))
} finally {await browser.close()}
