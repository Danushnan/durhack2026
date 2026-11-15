# Educational journeys and Checkout

Based on freshly fetched main `334adc8` (which includes `5fa18ac`). Work is isolated
on `codex/journey-education-checkout`; no unrelated branch was merged. The initial
working tree was clean. The newly integrated district/demo-road changes remain.

## Supported actions

- **Add to Basket:** the original nine stages, two explicit request IDs per click.
- **Place Order:** nine stages representing the seven logical Checkout phases,
  with Cart→Redis snapshot/finalisation operations shown separately. Each attempt
  has one new action ID and one new request ID. The existing checkout idempotency
  key stays in MiniShop; it is neither the action ID nor the request ID.
- **Checkout outcomes:** successful new order, explicit saved-order reuse, selected
  payment duration/slowdown, HTTP 402 decline with rollback, observed communication
  failure, partial evidence, and cleanup failure after a confirmed order.

Every step presents a friendly heading and short **What / Why / Why it matters**
answers. Definitions and technical events are expandable. Labels distinguish
Observed, Browser-reported, Inferred and Partial. A failure is still an observed
fact when supported by an event. General explanations of a component’s role are
not assertions that a missing operation happened.

The existing pairing, polling, viewer isolation, event deduplication, Previous /
Next / Replay, gold guide and road geometry are reused. No collector, health,
history, demo controls, scene, shared roads or roundabouts were replaced. The
request-registration message name stays backward compatible. Basket registration
payloads from `5fa18ac` still work; the kind defaults to Add to Basket.

## Evidence rules

Only validated, request-associated observations from the selected live collector
are used. The existing application/namespace/time/source checks, event identities,
viewer tokens, capacity limits and five-minute expiry remain. Add to Basket
collects for 30 seconds. Checkout collects for 60 seconds to cover its existing
45-second timeout plus collection delay. Polling caches evidence as before.

Two small `measured` wrappers instrument actual existing Checkout branches:
`orders.persist` covers insertion of order/items and result readback;
`orders.reuse` covers reading the existing order result. Neither changes the
transaction, payment, idempotency, cleanup, or stock logic. Neither is labeled as a
single SQL statement duration. A successful persist wrapper alone does not prove
commit: the completed outer transaction and successful Checkout root are also
required before confirming a new order.

A retry skips snapshot, catalogue validation and Payment **only when a successful
`orders.reuse` observation is present**. Those skipped stages are marked Inferred
from the reviewed code branch and reuse evidence. No fictitious skipped-call
measurement or road is drawn. Absence of Payment logs alone never proves reuse.

Payment duration is the selected Checkout→Payment `http_client` observation’s
latency, never a sum of nested measurements. `orders.transaction` includes waiting
for Cart/Product/Payment and is explicitly not SQL-only latency. HTTP 402 plus
`orders.transaction.outcome=rolled_back` supports a declined attempt and rollback,
not a PostgreSQL or Kubernetes infrastructure outage. A transport error such as
`ReadTimeout` is distinguished from an actual HTTP error response from Payment.

Cart’s `basket.freeze`, `basket.mutate` and `basket.finish` wrappers do not establish
the resulting basket contents by themselves. Finalisation behavior on rollback is
labeled Inferred from the code, not a directly observed preservation measurement.
The browser’s `basket_cleared` response flag is stored as browser evidence only;
it never proves that Redis was emptied. A cleanup failure does not erase a
separately confirmed order. No step claims that stock is decremented.

## Stage text and required evidence

The following copy is generated from the same reviewed templates as the UI. “What”
changes for observed failure, missing events and browser outcomes as described
below. Actual statuses and durations are inserted only from selected observations.

### Add to Basket

#### 1. Ask the shop to add an item

- **What:** Storefront sends a separate basket change request to Cart.
- **Why:** The website handles clicks; Cart is a backend service that manages baskets.
- **Why it matters:** Sending the change to Cart lets the server check it before accepting it.
- **Required evidence:** Cart http_server POST /carts/{session}/items, source minishop-web.
- **Term help:** An HTTP request is a message one program sends to another.

#### 2. Check the product

- **What:** Cart asks Product for the item’s availability.
- **Why:** Product owns the catalogue, so Cart asks it for current item information.
- **Why it matters:** Cart needs availability information before it can decide whether to accept this change.
- **Required evidence:** Cart http_client GET /products/{id}, target Product.
- **Term help:** Microservices are small programs with separate responsibilities.

#### 3. Look in the catalogue database

- **What:** Product looks up item details in PostgreSQL, the shop’s catalogue database.
- **Why:** PostgreSQL stores the shop’s product records; Product reads them here.
- **Why it matters:** The basket check uses stored product information rather than trusting the website.
- **Required evidence:** Product dependency products.select_one, target PostgreSQL.
- **Term help:** A database stores information so services can retrieve it later.

#### 4. Try to update the basket

- **What:** Cart attempts a basket mutation in Redis. This operation alone does not prove the change was accepted.
- **Why:** Redis remembers basket data. Cart runs an atomic basket change there.
- **Why it matters:** An atomic change avoids two requests to the same basket overwriting each other. The operation’s completion alone does not prove the change was accepted.
- **Required evidence:** Cart dependency basket.mutate, target Redis.
- **Term help:** Atomic means the data store handles the change as one indivisible operation.

#### 5. Find out whether it worked

- **What:** Cart accepted the basket change (successful mutation root response).
- **Why:** Cart returns the overall result after checking the product and attempting the change.
- **Why it matters:** This final response determines whether Cart accepted the basket change; a completed Redis wrapper is not enough.
- **Required evidence:** Successful Cart POST root. A rejected/failed root instead says Cart did not accept the change.
- **Term help:** An HTTP status describes the response: 2xx is success; 4xx is rejection; 5xx is a server-side failure.

#### 6. Ask for the updated basket

- **What:** Storefront makes a second request to refresh the basket, using a different request ID.
- **Why:** Changing a basket and reading its display are two separate requests in MiniShop.
- **Why it matters:** The website needs the server’s basket contents before it can update the display accurately.
- **Required evidence:** Separate Cart http_server GET /carts/{session}, source minishop-web.
- **Term help:** The refresh has its own request ID; both requests belong to this one click.

#### 7. Read the saved basket

- **What:** Cart reads basket data from Redis, the store that remembers the basket.
- **Why:** Cart reads the basket from Redis, where its item identifiers and quantities are remembered.
- **Why it matters:** The display should reflect server data, including changes that another request may have made.
- **Required evidence:** Cart dependency basket.get, target Redis, under the refresh request ID.

#### 8. Make the basket readable

- **What:** Cart asks Product for catalogue details needed to display the basket.
- **Why:** Redis stores basket references; Product supplies the catalogue details used in the display.
- **Why it matters:** The website needs product details and prices to present the basket to you.
- **Required evidence:** Cart http_client GET /products, target Product, under the refresh request ID.
- **Term help:** A service can combine information from more than one data store without those stores calling each other.

#### 9. Show the basket on the website

- **What:** The browser reports that it updated the displayed basket.
- **Why:** The frontend turns the returned basket into the page you see.
- **Why it matters:** A change can be accepted even if the separate refresh fails. Browser feedback and backend observations answer different questions.
- **Required evidence:** Explicit browser success report after scheduling its basket display update; backend evidence remains separate.
- **Term help:** Frontend means the part of the application running in your browser.

### Place Order

#### 1. Ask Checkout to place the order

- **What:** The website’s order request reached Checkout, the service that coordinates placing orders.
- **Why:** The website cannot coordinate an order by itself. Checkout brings the basket, catalogue, payment and order records together.
- **Why it matters:** One coordinator decides whether this shopping action can finish safely.
- **Required evidence:** Checkout http_server POST /checkout/{session}, source minishop-web.
- **Term help:** A backend service is a program on the server, separate from the page in your browser.

#### 2. Take a stable basket snapshot

- **What:** Checkout asked Cart for a stable basket snapshot before attempting the order.
- **Why:** Cart owns the basket, so Checkout asks Cart for its current contents and a short-lived lock.
- **Why it matters:** The order needs a consistent basket while its details are being checked.
- **Required evidence:** Checkout http_client POST /internal/carts/{session}/snapshot, target Cart.
- **Term help:** A snapshot is a copy of data at a particular point; a lock temporarily prevents conflicting changes.

#### 3. Protect the basket during checkout

- **What:** Cart ran its Redis basket-freeze operation. Its completion alone does not establish a non-empty snapshot or an accepted order.
- **Why:** Cart uses Redis to coordinate the basket lock and read the saved basket.
- **Why it matters:** Concurrent changes must not silently alter the order being checked. The freeze operation can still lead to a rejected checkout.
- **Required evidence:** Cart dependency basket.freeze, target Redis.
- **Term help:** Redis is the data store MiniShop uses to remember and coordinate baskets.

#### 4. Check items and quantities

- **What:** Checkout fetched the current catalogue. Reaching the Payment call indicates its item and quantity checks passed in the reviewed code; those checks are not separately measured.
- **Why:** Product supplies the current catalogue. Checkout checks that the requested items and quantities are available.
- **Why it matters:** Checking again avoids accepting an order based only on an older basket display. MiniShop does not decrement stock here.
- **Required evidence:** Successful Checkout→Product GET /products plus observed Payment call for inferred validation progression. Product products.select is optional supporting evidence. Without the Payment call, validation success is not claimed.
- **Term help:** Validation means checking that the requested data satisfies the shop’s rules.

#### 5. Ask for a simulated payment

- **What:** Payment answered with the observed HTTP status after the selected measured duration. Checkout waited for this call. Healthy pods do not guarantee a fast response.
- **Why:** The Payment Service returns a test acceptance or decline; Checkout waits for it before saving a new order.
- **Why it matters:** A decline stops this attempt. This selected call’s duration is separate from rolling service health and pod readiness.
- **Required evidence:** Checkout http_client POST /payments, target Payment. The exact outgoing-call duration is shown. Payload acceptance is asserted only with a successful root response.
- **Term help:** A Kubernetes pod runs service code. A ready pod can still respond slowly or reject a business request.

#### 6. Finish the order transaction

- **What:** The order transaction wrapper completed. Its duration includes waiting for other services, so it is not a measurement of SQL execution alone.
- **Why:** PostgreSQL groups order changes in a transaction and also stores previously completed orders for safe retries.
- **Why it matters:** A commit makes changes durable; a rollback discards this transaction’s changes. The broad wrapper includes other service calls, not just SQL.
- **Required evidence:** Checkout dependency orders.transaction, target PostgreSQL. Confirmed new order additionally requires orders.persist plus successful transaction and root; confirmed reuse requires orders.reuse instead.
- **Term help:** Idempotency means a retry can return the saved result instead of performing the shopping operation again.

#### 7. Ask Cart to tidy up

- **What:** Checkout asked Cart to finalise the basket after the order attempt. This is a separate cleanup call, not a PostgreSQL-to-Redis connection.
- **Why:** Checkout asks Cart to finalise the basket after it knows whether the order transaction completed.
- **Why it matters:** Cleanup follows the result: the normal path requests clearing a matching basket; the rollback path requests releasing its lock. The call alone does not prove either data outcome.
- **Required evidence:** Checkout http_client POST /internal/carts/{session}/finish, target Cart.
- **Term help:** A cleanup failure can happen after an order was already saved; it does not undo that order.

#### 8. Finish basket coordination in Redis

- **What:** Cart ran its Redis finalisation operation. This wrapper does not reveal whether any basket data was removed.
- **Why:** Cart owns the Redis keys and performs the requested finalisation there.
- **Why it matters:** Version and lock checks protect newer basket changes. A completed wrapper does not prove the basket was emptied.
- **Required evidence:** Cart dependency basket.finish, target Redis. Rollback-path purpose is labeled inferred when supported by the rollback event.
- **Term help:** A version identifies which basket revision the order used.

#### 9. Show the order outcome

- **What:** The browser reports that it received an order result and opened the confirmation page.
- **Why:** The frontend turns Checkout’s response into a confirmation page or an error message.
- **Why it matters:** The browser report is separate from backend evidence. If the response is lost, the saved checkout key makes a retry safer.
- **Required evidence:** Explicit browser report from the confirmation render effect; no invented backend event.
- **Term help:** The checkout idempotency key is not the journey action ID or the HTTP request ID.

## Failure, retry, and missing-evidence copy

- Missing backend events: **“Observation unavailable for this stage.”** The state
  is Pending while collecting, then Partial/Unavailable. No successful path or
  duration is substituted.
- Rejected mutation root: **“Cart did not accept the basket change. Inspect the
  root HTTP status below.”** A completed `basket.mutate` remains insufficient proof.
- Mutation request failed before refresh: the browser stage says **“The browser
  did not send a basket refresh because its mutation request failed.”**
- Browser basket-refresh failure: **“The browser reports that the basket refresh
  failed; the mutation may still have succeeded.”** The separate root acceptance
  summary identifies when backend acceptance is confirmed.
- HTTP 402 Payment: **“The simulated Payment Service declined this request with
  HTTP 402 after [measured duration]. Checkout cannot complete a new order through
  this declined attempt.”**
- Payment transport failure: **“Checkout recorded failed communication with
  Payment ([recorded error]) after [measured duration]. This observation does not
  establish a Payment HTTP response or Kubernetes pod failure.”**
- An actual HTTP error response is instead described as **“Payment answered with
  HTTP [observed status] after [measured duration]. Checkout could not use that
  response to continue normally.”** No controlled HTTP 5xx response is fabricated.
- Rollback: **“The order transaction rolled back. Its changes were not committed;
  this is not evidence that PostgreSQL infrastructure failed.”**
- Observed saved-order reuse: snapshot, freeze, validation and Payment stages say
  **“A saved-order reuse was observed. The reviewed retry path skips this stage;
  it does not repeat the payment or create another order.”** Those are Inferred
  skipped stages with reuse event IDs, not invented calls or measurements.
- Confirmed order plus failed cleanup: **“Checkout’s basket finalisation call
  failed. The order result is confirmed; cleanup failure does not undo that
  order.”** Journey state is Partial and the order stays separately confirmed.
- Browser Checkout failure: **“The browser reports that the order request failed.
  A transport failure can leave the backend outcome uncertain; retrying uses the
  saved checkout key.”**

## Files changed

- `backend/journeys.py`: compatible typed registrations, immutable associations,
  explicit registered request IDs in technical details, Checkout collection window.
- `backend/journey_education.py`: all reviewed headings, purpose/importance copy,
  term help, and evidence labels.
- `backend/journey_evidence.py`: redacted event serialization and small evidence
  helpers shared by the two fixed journey types.
- `backend/checkout_journey.py`: Checkout reconstruction and truthful outcome rules.
- `backend/test_journeys.py`, `backend/test_checkout_journey.py`: educational copy,
  acceptance, failures, cleanup, retry, ambiguity, collection and isolation tests.
- `minishop/services/checkout/app.py`: `orders.persist` / `orders.reuse` wrappers
  around existing operations; business behavior unchanged.
- `minishop/frontend/src/journey.ts`, `App.tsx`: explicit Checkout action/report
  through existing pairing; confirmation report follows the rendered route effect.
- `minishop/frontend/tests/journey.test.mjs`: independent retry/action/request IDs.
- `frontend/src/journeyProtocol.ts`, `Journey.tsx`, `App.tsx`, `City.tsx`,
  `index.css`: educational presentation, compatible typed messages, action labels,
  Checkout summaries, evidence details and correct stationary focus for skipped
  and browser stages. Source changes do not retain another source’s highlights.
- `frontend/tests/journeyProtocol.test.ts`, `checkout.browser.mjs`: reviewed
  metadata and real browser Checkout/pairing/playback checks.
- `minishop/tests/test_demo_control.py`: restore the shared test fixture’s Checkout
  URL after the rejecting-provider test; no admin/demo runtime change.
- `minishop/tests/journey.compose.yaml`: opt-in disposable Compose test override.
- `minishop/scripts/verify-journey-observations.py`: opt-in real HTTP and genuine
  log verification against a disposable local Compose stack.
- `JOURNEY_VIEW.md`, `JOURNEY_EDUCATION.md`: original milestone note and this report.

## Verification

- Full backend regression tests: **114 passed**, including
  optional history persistence against a disposable local PostgreSQL database.
- MiniShop: **20 tests passed**, with real PostgreSQL/Redis and independent HTTP
  service processes. The test-only fixture leak was corrected before this result.
- Frontend traffic/Discovery/live monitoring/protocol tests and MiniShop action
  tests passed; both frontends passed TypeScript and production builds. The
  pre-existing large KubeVerse JavaScript chunk warning remains.
- Isolated Compose, genuine validated logs: new order **15 observations**;
  idempotent retry **7 observations**, explicit reuse and no Payment call;
  slowdown **1607.34 ms** for the selected outgoing Payment call;
  HTTP 402 **14 observations**, observed rollback, independent no-order and
  retained-basket HTTP checks; real paused-provider communication timeout
  **10007.84 ms**, with rollback and no invented Payment HTTP response.
- Real Chromium + unchanged Kubernetes MiniShop: educational basket explanations,
  explicit Checkout registration, observed order response, browser confirmation,
  **one Checkout request**, **14 events**, selected outgoing Payment duration
  **110.05 ms**, and playback without duplicate requests. No browser page errors.
  The old deployed image provides no `orders.persist`/`orders.reuse` event. The
  UI confirms the order result while leaving the new-versus-reused distinction
  pending during collection and partial at expiry, as required.

The Compose test infrastructure is separate from Kubernetes. It uses cached
images, a read-only mount of the updated Checkout source, and its own database,
Redis and payment processes. Slow/decline/paused-provider scenarios were performed
only there; no shared Kubernetes payment setting was modified.

## Demo and safe integration

The original loopback instructions in `JOURNEY_VIEW.md` still apply: backend 8011,
KubeVerse 5181, updated MiniShop frontend 5182, existing Kubernetes gateway 8080.
Set `KUBEVERSE_JOURNEYS=1` only on the trusted local backend. Pair MiniShop from
Journey View, add an item, open the basket, review checkout and click **Place demo
order**. Switch the action selector between Add to Basket and Place Order.
Previous / Next / Replay only play observations. Registered request IDs, actual
routes/operations, statuses, durations and outcomes are in the expandable details.

Integrate the backend and both frontend changes together. To distinguish new
orders from retries completely, the Checkout service also needs the two new
instrumentation wrappers. Until that source is deliberately deployed, the guide
handles old images honestly as partial evidence. **No shared image deployment is
performed automatically.** Roads, collector, WebSocket, health and history need no
migration. The changed transaction wrappers introduce additional dependency log
records around actual PostgreSQL work; broad service health classification remains
unchanged.

Review and integrate only after checks:

```bash
git diff origin/main...codex/journey-education-checkout
# On main, when ready to integrate:
git switch main
git pull --ff-only
git merge --no-ff codex/journey-education-checkout
```

If main advances, resolve conflicts and recheck on the feature branch first. No
push or merge is automatic. Keep the original `5fa18ac` history intact.

Useful checks:

```bash
python -m pytest -q backend
(cd frontend && npm test && npm run build)
(cd minishop/frontend && npm run test:journey && npm run build)
(cd minishop && python -m pytest -q tests)
# Opt-in: creates simulated shopping actions using the existing local demo ports
node frontend/tests/journey.browser.mjs
node frontend/tests/checkout.browser.mjs
node frontend/tests/journey.scenarios.mjs
```

`PLAYWRIGHT_MODULE` and `CHROME_PATH` can select an existing Playwright install and
Chromium executable. Real-HTTP local-stack verification is available through
`minishop/scripts/verify-journey-observations.py --outcome success|slow|decline|unavailable`;
it expects the separately provisioned `kv-journey-education` Compose project and
loopback gateway 18080. It changes no service settings itself. Browser evidence and
screenshots are written under `/tmp`.

## Limits

This is a reviewed MiniShop guide, not a general distributed tracing interpreter.
Validation progression and skipped retry branches are explicitly inferred from
known code and positive observations. SQL statement-level timings, payloads,
stock decrement, actual basket clearing, and unobserved outcomes are not invented.
The guide remains a browser-paired, bounded, in-memory demo with the same opener,
expiry, polling, source-switch and local-registration limits as the first milestone.


### Disposable local scenario setup

With the existing MiniShop images available locally, Compose 2.24.4+ supports the
port override used by the test file. These commands explicitly use a separate
project; do not substitute a shared project name.

```bash
docker compose -p kv-journey-education -f minishop/compose.yaml -f minishop/tests/journey.compose.yaml up -d --no-build --pull never --wait
python minishop/scripts/verify-journey-observations.py --outcome success
# Only this disposable provider is recreated for a slowdown:
JOURNEY_TEST_PAYMENT_DELAY_MS=1600 docker compose -p kv-journey-education -f minishop/compose.yaml -f minishop/tests/journey.compose.yaml up -d --no-deps --no-build --wait payment-api
python minishop/scripts/verify-journey-observations.py --outcome slow
# Only this disposable provider is recreated for a decline:
JOURNEY_TEST_PAYMENT_FAIL=true docker compose -p kv-journey-education -f minishop/compose.yaml -f minishop/tests/journey.compose.yaml up -d --no-deps --no-build --wait payment-api
python minishop/scripts/verify-journey-observations.py --outcome decline
# Clean up only the disposable test project and its test data:
docker compose -p kv-journey-education -f minishop/compose.yaml -f minishop/tests/journey.compose.yaml down -v
```

For full MiniShop tests, create `minishop_test` in the disposable PostgreSQL
container first; for the optional history test, create `kubeverse_history_test`
and set `KUBEVERSE_LIVE_HISTORY_TEST_DATABASE_URL` to that database. Never point
these tests at a shared or production database. The disposable stack used in this
session was removed after verification, including its volumes.

The final panel puts the teaching questions ahead of expandable outcome summaries and the legend. Browser checks were run serially after concurrent software-rendered city instances caused automation timeouts. The serial basket, concurrent-action scenario, and final Checkout checks passed.
