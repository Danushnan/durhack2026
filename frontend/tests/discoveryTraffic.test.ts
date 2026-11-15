import assert from 'node:assert/strict'
import {test} from 'node:test'
import {startsDiscoveryActivity,type DiscoveryActivityPeriod} from '../src/discoveryTraffic.ts'
import {admit} from '../src/traffic.ts'

test('one measured request starts a visible period without waiting for car admission credit',()=>{
 const state:DiscoveryActivityPeriod={source:'live',active:false}
 const one={requests:1,rps:.2}
 assert.ok(startsDiscoveryActivity(state,one,'live'))
 // Representative car is charged against the same visual admission budget.
 let credit=-1
 for(let frame=0;frame<300;frame++){
   assert.equal(startsDiscoveryActivity(state,one,'live'),false)
   const next=admit(credit,one.rps,1/60,[],()=>.5,.6)
   assert.equal(next.leave,false)
   credit=next.credit
 }
 assert.equal(one.requests,1)
 assert.equal(one.rps,.2)
})

test('repeated/rising/falling positive rolling counts do not create repeated burst cars',()=>{
 const state:DiscoveryActivityPeriod={source:undefined,active:false}
 assert.ok(startsDiscoveryActivity(state,{requests:2,rps:.4},'live'))
 for(const requests of [2,2,3,2,1,1])assert.equal(startsDiscoveryActivity(state,{requests,rps:requests/5},'live'),false)
 assert.equal(startsDiscoveryActivity(state,{requests:0,rps:0},'live'),false)
 assert.ok(startsDiscoveryActivity(state,{requests:1,rps:.2},'live'))
 assert.equal(startsDiscoveryActivity(state,{requests:1,rps:.2},'live'),false)
})

test('missing data does not rearm a period, while a source switch starts a separate visual context',()=>{
 const state:DiscoveryActivityPeriod={source:'a',active:true}
 for(const data of [{requests:undefined,rps:.2},{requests:NaN,rps:.2},{requests:1,rps:NaN},{requests:-1,rps:.2}])assert.equal(startsDiscoveryActivity(state,data,'a'),false)
 assert.equal(startsDiscoveryActivity(state,{requests:1,rps:.2},'a'),false)
 assert.ok(startsDiscoveryActivity(state,{requests:1,rps:.2},'b'))
 assert.equal(startsDiscoveryActivity(state,{requests:1,rps:.2},'b'),false)
})
