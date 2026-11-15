import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
const ws = new WebSocket('ws://127.0.0.1:15173/ws')
const snapshots = []
ws.onmessage = ({data}) => {
  for (const event of JSON.parse(data)) {
    if (event.type === 'TRAFFIC') snapshots.push(event.edges)
  }
}
await once(ws, 'open')
const exit = once(spawn(process.argv[2], ['-B','minishop/scripts/traffic.py','--base','http://127.0.0.1:18080','--count','5'], {stdio:'inherit'}),'exit')
assert.equal((await exit)[0], 0)
await new Promise(resolve => setTimeout(resolve, 11000))
const peak = snapshots.find(edges => edges.some(e => e.to === 'minishop/payment-api' && e.recentRequests > 0))
assert.ok(peak, 'live checkout call reached Vite')
const idle = snapshots.at(-1).find(e => e.to === 'minishop/payment-api')
assert.ok(idle && idle.requests >= 1 && idle.rps === 0, 'street retained after recent traffic expired')
console.log('Verified live checkout events and idle street retention via Vite')
const telemetry = await fetch('http://127.0.0.1:15173/api/telemetry').then(r => r.json())
console.log('Analytics status:', telemetry.status)
ws.close()
