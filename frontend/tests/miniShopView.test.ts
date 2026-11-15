import assert from 'node:assert/strict'
import {test} from 'node:test'
import {miniShopView} from '../src/miniShopView.ts'
import type {ClusterState, K8sObject} from '../src/k8s.ts'

const workload = (name: string, namespace = 'minishop', replicas = 1): K8sObject => ({
  kind:'Deployment', metadata:{uid:`${namespace}/${name}`,name,namespace}, spec:{replicas},
})
test('MiniShop display keeps its seven components, including scaled-down failures, and removes unrelated roads', () => {
  const names=['minishop-web','product-api','cart-api','checkout-api','payment-api','postgres','redis']
  const objects=[...names.map(name=>workload(name,'minishop',name==='payment-api'?0:1)),
    workload('notifications','kubeverse-platform',0),workload('search','kubeverse-data',0),
    workload('shipping','kubeverse-fulfilment',0),workload('cache','kubeverse-data',0),
    {kind:'Node',metadata:{uid:'node',name:'worker'}}]
  const edges=[{from:'minishop/checkout-api',to:'minishop/payment-api',rps:1,healthy:false},
    {from:'kubeverse-data/search',to:'kubeverse-data/cache',rps:0,healthy:false}]
  const state: ClusterState={context:'kind-minishop',connected:true,objects:Object.fromEntries(objects.map(o=>[o.metadata.uid,o])),edges}
  const view=miniShopView(state)
  assert.equal(Object.values(view.objects).filter(o=>o.kind==='Deployment').length,7)
  assert.ok(view.objects['minishop/payment-api'])
  assert.ok(view.objects.node)
  assert.deepEqual(view.edges,[edges[0]])
  assert.equal(Object.keys(state.objects).length,12,'raw watch data must remain intact')
  assert.equal(state.edges.length,2)
})
test('simulator and live clusters without MiniShop retain their original presentation', () => {
  const state: ClusterState={context:null,connected:true,objects:{shop:workload('minishop-web')},edges:[]}
  assert.strictEqual(miniShopView(state),state)
  const other={...state,context:'another-cluster',objects:{search:workload('search','other')}}
  assert.strictEqual(miniShopView(other),other)
})
test('map-preview controls choose visible MiniShop services instead of hidden demo workloads', async () => {
  const {reduceWatchMessage} = await import('../src/watch.ts')
  const resources=[workload('minishop-web'),workload('cart-api'),workload('notifications','kubeverse-platform')]
  const cluster: ClusterState={context:'kind-minishop',connected:true,objects:Object.fromEntries(resources.map(o=>[o.metadata.uid,o])),edges:[]}
  const next=reduceWatchMessage(cluster,[{type:'DEMO_PACKETS',count:5,cross_district:false}],1000,42)
  const routes=Object.values(next.demoPackets!.routes)
  assert.ok(routes.length>0)
  assert.ok(routes.every(({call})=>call.from.startsWith('minishop/')&&call.to.startsWith('minishop/')))
  assert.equal(routes.reduce((sum,route)=>sum+route.count,0),5)
})
