import assert from 'node:assert/strict'
import {test} from 'node:test'
import {compactLiveTag, liveServiceView} from '../src/liveMetrics.ts'
import {snapshot, paymentDeployment} from './liveMetrics.fixture.ts'
import type {ClusterState} from '../src/k8s.ts'
const state: ClusterState={context:'kind-minishop',connected:true,objects:{[paymentDeployment.metadata.uid]:paymentDeployment},edges:[],metrics:snapshot()}
const view=liveServiceView(paymentDeployment,state)!
test('healthy unselected labels can collapse; selected and changing services keep detail',()=>{
 assert.equal(compactLiveTag(view,false),true)
 assert.equal(compactLiveTag(view,true),false)
 assert.equal(compactLiveTag(view,false,true),false)
})
test('idle, unknown, partial, stale, disconnected and degraded states stay explicit',()=>{
 for(const availability of ['idle','partial','stale','loading','disconnected'] as const)
  assert.equal(compactLiveTag({...view,availability},false),false)
 assert.equal(compactLiveTag({...view,application:'unknown'},false),false)
 assert.equal(compactLiveTag({...view,application:'degraded'},false),false)
 assert.equal(compactLiveTag({...view,infrastructure:'degraded'},false),false)
 assert.equal(compactLiveTag({...view,current:false},false),false)
})
test('healthy data stores can collapse without implying they have HTTP measurements',()=>{
 assert.equal(compactLiveTag({...view,application:'not_applicable',availability:'unsupported'},false),true)
 assert.equal(compactLiveTag({...view,application:'not_applicable',availability:'stale'},false),false)
})
