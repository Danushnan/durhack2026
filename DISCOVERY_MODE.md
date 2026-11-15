# Discovery: current relationships, explained

Implemented on the existing `codex/journey-education-checkout` working branch,
starting from commit `fdd325d` plus the existing uncommitted Journey follow-camera
and speed changes. Those Journey changes were preserved. No backend, shopping,
request correlation, persistence or demo-controller code was changed.

## Changes

- `frontend/src/DiscoveryActivityPanel.tsx`: Recent Activity panel, always-present
  guidance, typical-purpose descriptions, five-second counts/rates, timing and
  outcome shares, selection controls and a direct switch to Journey.
- `frontend/src/discoveryActivity.ts`: reviewed MiniShop relationship dictionary
  and bounded selection of current measured edges (up to 12, busiest first).
- `frontend/src/DiscoveryFocus.tsx`: selected relationship's actual outbound lane
  and endpoint rings, using the existing shared street/roundabout geometry.
- `frontend/src/App.tsx`: selection scoped to the live source, reset handling,
  existing service inspector integration, and independent Discovery/Journey UI.
- `frontend/src/City.tsx`: calmer Discovery-only car rendering, idle-road emphasis
  fade, shared-segment selection, endpoint highlighting and directed lane overlay.
- `frontend/src/index.css`: compact scrollable activity panel and responsive styles.
- `frontend/tests/discoveryActivity.test.ts`: rolling-window, source/freshness,
  reset, directed-edge, preview separation and reviewed-description checks.

No new endpoints, dependencies, telemetry subscriptions or per-frame React updates
were introduced. Existing traffic/Discovery/frontend tests and production build
are the required checks; real browser interaction is left for manual testing.

## What the measurements mean

Entries come directly from `cluster.edges`, the existing real TRAFFIC snapshot.
Only revealed, directed MiniShop edges with positive measured integer counts and
rates, matching live workload identities and a complete caller window are listed.
Disconnected, stale, mismatched, unarmed or reset sources do not assert current
activity. The separate admin-preview queue never becomes a measured list entry.

TRAFFIC is a **rolling five-second window**, independent of the ten-second service
health window. Repeated snapshots replace the displayed count; they never add to
an event total. Items sort by the measured rate/count, not by an invented event
timestamp. Neither individual request identity nor chronological flow exists in
this aggregate message.

The reviewed relationships are:

| Relationship | Type | Typical purpose |
| --- | --- | --- |
| Storefront → Product | HTTP | Retrieve catalogue information for the website. |
| Storefront → Cart | HTTP | Read or change the basket. |
| Storefront → Checkout | HTTP | Place an order or retrieve saved orders. |
| Cart → Product | HTTP | Validate items or obtain basket display details. |
| Cart → Redis | Cache operation | Read, change or coordinate the stored basket. |
| Product → PostgreSQL | Database operation | Access the catalogue. |
| Checkout → Cart | HTTP | Obtain a snapshot or finalise basket coordination. |
| Checkout → Product | HTTP | Retrieve current catalogue data for order checks. |
| Checkout → Payment | HTTP | Request a simulated payment for a new order. |
| Checkout → PostgreSQL | Database operation | Read saved orders or coordinate saving an order. |

Each entry explicitly says **Typical purpose**. It does not identify which of
those code paths ran in a particular request. Unknown pairs/namespaces receive a
generic unreviewed-purpose description and no guessed protocol.

Counts represent instrumented completions. Database/cache operation counts are
not SQL statement counts, item counts, unique browser clicks or network packet
counts. Displayed average durations are copied from the edge's available timed
samples; no nested durations are added. The backend already excludes the broad
`orders.transaction` wrapper from edge latency; this frontend does not relabel
that as SQL latency. Reply error/non-success and communication-failure shares are
shown separately when supplied, without claiming a pod outage or exact status.

## Calmer rendering and selection

Discovery uses 60% of the prior live car admission density (40% fewer sampled
arrivals). Actual `rps`, counts, outcomes and timing remain untouched. No minimum
rate, vehicles or requests are fabricated, and window counts are never used as
new-event increments. A newly observed active period now gets an immediate representative car, even
when its measured rate is too low to reach the normal admission threshold. This
is a visual acknowledgement of measured activity, not an additional request. Its
one-unit admission debit avoids immediately adding a second rate-driven car.
Repeated positive snapshots, including changing counts within the same active
period, do not retrigger this cue.

Once a measured window is idle, its old admission credit is discarded, but cars
already dispatched finish their illustrated trips visibly rather than vanishing.
A measured zero-count/zero-rate window rearms the next activity-period cue. Source
changes reset the cue and old cars; unavailable telemetry still pauses rendering. Unselected road
outlines fade toward idle emphasis. Revealed roads, building lots and the street
network stay in place. When a connection is selected, unrelated cars are hidden
and unrelated road outlines dim. Explicit admin preview cars are also hidden
when unrelated to that selection; their admin behavior is unchanged.

Shared physical segments are highlighted when their logical call set contains the
selected directed edge. A cyan overlay follows that relationship's existing
outbound lane, including roundabouts, and rings mark its two buildings. This
shows which relationship was selected without pretending the pavement belongs
exclusively to it. Selecting a row does not force a camera jump. Inspect buttons
reuse the normal service inspector and camera controls.

An explicitly selected dependency stays highlighted after becoming idle; the
selection panel reports Idle or unavailable measurements rather than reusing old
counts as current activity. Clear highlight returns the normal activity view.
Reset Discovery clears this selection and retains the original reveal/arming
rules. Changing source clears selection; Journey hides all Discovery-specific
selection/rendering without touching its gold guide, explanations, speed or replay.

## Manual testing

1. Refresh `http://127.0.0.1:5181`. Leave Traffic selected; Discovery is the default
   road mode. Allow the existing reveal/telemetry warm-up to finish.
2. In MiniShop (`http://127.0.0.1:5182`), browse products or Add to Basket.
3. Recent Activity should show the measured active relationships, their typical
   purpose, HTTP/store-operation label, current count/rate and timed information.
   It should not claim a particular product, operation name or request journey.
4. Click Cart → Product or Cart → Redis. Both buildings and the corresponding
   existing lane should be cyan; unrelated cars should disappear. Shared streets
   remain shared. Use Inspect to open the ordinary service inspector.
5. Stop interacting and wait for the rolling window/collector to catch up. Rows
   should disappear as activity becomes idle; road emphasis fades but the revealed
   topology stays. A selected connection remains selectable with an Idle message.
6. Clear highlight or Reset Discovery. Reset should clear the selection and begin
   the normal new-window reveal process.
7. Use “Follow one shopping action in Journey” and the existing pairing workflow.
   The left educational panel, gold guide, speed selector (default 0.5×) and replay
   remain as before. Return using Traffic.
8. Optional: run an existing admin map preview. Its illustrated vehicles should not
   add measured activity entries or alter measured rates.

## Limits

Collection/publishing delays and rolling windows remain. The list has no exact
last-event timestamp or chronological shopping flow. Cars are sampled animations,
not individual request evidence, and their travel time is not network latency.
Discovery is deliberately distinct from the explicitly registered Journey action.

## Recorded checks

- Frontend suite: all **5 test files passed**, including traffic, shared-road /
  Discovery reset/reconnect behavior, live monitoring and Journey protocol checks.
- TypeScript project check: **passed**.
- Vite production build: **passed**; the existing large JavaScript chunk warning
  remains unchanged.
- Browser interaction is intentionally left for manual testing. No new end-to-end
  infrastructure, Kubernetes operation, push or merge was performed.


### Small-burst visibility fix

`frontend/src/discoveryTraffic.ts` tracks only whether a measured logical
connection has moved from idle to active for the current source. It does not add
rolling counts or infer request identity. `City.tsx` uses that transition for one
immediate car when the existing exit/pool permits it; sustained activity continues
through the existing reduced-density rate admission. Counts, rates, Journey,
roundabouts and admin preview semantics are untouched. Cars finish their trips
when activity becomes idle, and the panel explains that animation can outlast the
measurement window. Focused tests cover one-request bursts, repeated/changing
windows, idle rearming, invalid data and source changes.
