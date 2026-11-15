"""Evidence-driven Checkout stages for the reviewed MiniShop handler only."""
import re
from journey_education import educate
from journey_evidence import public, step, successful


def reconstruct_checkout(rows, action, namespace, collecting, truncated):
    checkout, cart, product, payment, pg, redis, web = [namespace + '/' + name for name in
        ('checkout-api','cart-api','product-api','payment-api','postgres','redis','minishop-web')]
    rows = [r for r in rows if r.request_id == str(action.request_id)]
    roots = [r for r in rows if r.service == checkout and r.event == 'http_server' and r.source == web
             and r.method == 'POST' and re.fullmatch(r'/checkout/[^/]+', r.route or '')]
    ambiguous = len(roots) > 1 or any(r.event == 'http_server' and
        (r.source in (web, 'external') or r.service == checkout) and r not in roots for r in rows)
    def calls(service, target, method, route):
        return [r for r in rows if r.event == 'http_client' and r.service == service and r.source == service
                and r.target == target and r.method == method and re.fullmatch(route, r.route or '')]
    def operation(service, target, name):
        return [r for r in rows if r.event == 'dependency' and r.service == service and r.source == service
                and r.target == target and r.operation == name]
    snapshot = calls(checkout, cart, 'POST', r'/internal/carts/[^/]+/snapshot')
    freeze = operation(cart, redis, 'basket.freeze')
    catalogue = calls(checkout, product, 'GET', r'/products')
    catalogue_db = operation(product, pg, 'products.select')
    payments = calls(checkout, payment, 'POST', r'/payments')
    transaction = operation(checkout, pg, 'orders.transaction')
    persisted = operation(checkout, pg, 'orders.persist')
    reused = operation(checkout, pg, 'orders.reuse')
    finalise = calls(checkout, cart, 'POST', r'/internal/carts/[^/]+/finish')
    finish = operation(cart, redis, 'basket.finish')
    # These handlers do not retry child calls internally. Duplicates or incompatible
    # branches under one ID are not a trace we can safely teach as one checkout.
    ambiguous |= any(len(group) > 1 for group in (snapshot, freeze, catalogue, payments, transaction, persisted, reused, finalise, finish))
    ambiguous |= bool(reused and (snapshot or freeze or catalogue or payments or persisted))
    # Child Cart calls must use the root's basket when the root is available.
    if roots:
        basket = roots[0].route.split('/')[-1]
        ambiguous |= any(r.route.split('/')[3] != basket for r in snapshot + finalise)
    rollback = any(r.outcome == 'rolled_back' for r in transaction)
    root_ok = successful(roots) and not ambiguous
    new_order = root_ok and successful(transaction) and successful(persisted)
    reused_order = root_ok and successful(transaction) and successful(reused)
    ambiguous |= root_ok and rollback
    declined = len(payments) == 1 and payments[0].status == 402
    payment_duration = payments[0].latency_ms if len(payments) == 1 and not ambiguous else None
    payment_state = 'pending' if collecting else 'unavailable'
    payment_text = 'Observation unavailable for this stage.'
    if len(payments) == 1:
        observed = payments[0]
        duration = f'{observed.latency_ms:.2f} ms'
        if declined:
            payment_state = 'declined'
            payment_text = f'The simulated Payment Service declined this request with HTTP 402 after {duration}. Checkout cannot complete a new order through this declined attempt.'
        elif observed.error and not observed.error.startswith('HTTP ') and observed.status >= 500:
            payment_state = 'communication_failed'
            payment_text = f'Checkout recorded failed communication with Payment ({observed.error}) after {duration}. This observation does not establish a Payment HTTP response or Kubernetes pod failure.'
        elif observed.status >= 400:
            payment_state = 'http_failure'
            payment_text = f'Payment answered with HTTP {observed.status} after {duration}. Checkout could not use that response to continue normally.'
        else:
            payment_state = 'accepted' if root_ok else 'response_observed'
            payment_text = (f'Payment answered with HTTP {observed.status} after {duration}. ' +
                ('Checkout accepted the simulated payment response and returned an order. ' if root_ok else 'The payment payload and final order outcome are not established by this response alone. ') +
                'Checkout waited for this call. Healthy pods do not guarantee a fast response.')
    tx_text = ('The order transaction rolled back. Its changes were not committed; this is not evidence that PostgreSQL infrastructure failed.' if rollback else
               'The order transaction wrapper completed. Its duration includes waiting for other services, so it is not a measurement of SQL execution alone.' if successful(transaction) else
               'The order transaction did not complete normally. Inspect its recorded outcome; a failed wrapper alone does not diagnose a PostgreSQL outage.')
    if new_order:
        tx_text += ' Successful save and root-response observations support a committed new order.'
    elif reused_order:
        tx_text += ' A saved order was reused; this request did not insert a new order.'
    elif root_ok:
        tx_text += ' The successful root response confirms an order result; available observations do not distinguish a new order from a saved one.'
    validate_text = ('Checkout fetched the current catalogue. Reaching the Payment call indicates its item and quantity checks passed in the reviewed code; those checks are not separately measured.'
                     if successful(catalogue) and payments else
                     'Checkout requested the current catalogue. The available observations do not establish that all item and quantity checks passed.')
    cleanup_failed = any(r.status >= 400 or r.error for r in finalise + finish)
    finalise_text = ('Checkout’s basket finalisation call failed. ' +
        ('The order result is confirmed; cleanup failure does not undo that order.' if root_ok else 'Check the order result separately; this failure alone does not establish whether an order was saved.')
        if cleanup_failed else 'Checkout asked Cart to finalise the basket after the order attempt. This is a separate cleanup call, not a PostgreSQL-to-Redis connection.')
    steps = [
        step('checkout-request', 'The website’s order request reached Checkout, the service that coordinates placing orders.', roots, collecting, ambiguous, web, checkout),
        step('snapshot', 'Checkout asked Cart for a stable basket snapshot before attempting the order.', snapshot, collecting, ambiguous, checkout, cart),
        step('freeze', 'Cart ran its Redis basket-freeze operation. Its completion alone does not establish a non-empty snapshot or an accepted order.', freeze, collecting, ambiguous, cart, redis),
        step('validate', validate_text, catalogue + catalogue_db, collecting, ambiguous,
             checkout if catalogue else product, product if catalogue else pg,
             basis='inferred' if successful(catalogue) and payments else 'backend'),
        step('payment', payment_text, payments, collecting, ambiguous, checkout, payment),
        step('transaction', tx_text, transaction + persisted + reused, collecting, ambiguous, checkout, pg),
        step('finalise', finalise_text, finalise, collecting, ambiguous, checkout, cart),
        step('finish-store', 'Cart ran its Redis finalisation operation. This wrapper does not reveal whether any basket data was removed.', finish, collecting, ambiguous, cart, redis),
    ]
    if not catalogue and catalogue_db and not ambiguous:
        steps[3]['description'] = 'Product read catalogue data in PostgreSQL. The outgoing catalogue call and validation result are unavailable.'
    if reused and successful(reused) and not ambiguous:
        for index in (1,2,3,4):
            current = steps[index]
            current.update(description='A saved-order reuse was observed. The reviewed retry path skips this stage; it does not repeat the payment or create another order.',
                           state='skipped', basis='inferred', event_ids=[r.event_id for r in reused],
                           from_service=None, to_service=None, focus_service=checkout)
        payment_state = 'skipped'
    if rollback and finish and not ambiguous:
        steps[7]['description'] += ' The reviewed rollback path requests release of the basket lock rather than clearing; the resulting basket contents are not observed.'
        steps[7]['basis'] = 'inferred'
    browser = action.checkout
    steps.append(dict(key='confirmation', description=(
        'The browser reports that it received an order result and opened the confirmation page.' if browser == 'succeeded' else
        'The browser reports that the order request failed. A transport failure can leave the backend outcome uncertain; retrying uses the saved checkout key.' if browser == 'failed' else
        'The browser has not reported a completed order outcome.'),
        state=browser, event_ids=[], from_service=None, to_service=None, focus_service=web,
        basis='browser'))
    failed = rollback or any(r.status >= 400 for r in roots + payments) or browser == 'failed'
    # New/reused branch must be explicitly observed before declaring the complete
    # evidence path. Older deployed images without branch observations stay partial.
    complete = (new_order or reused_order) and all(s['state'] in ('observed','skipped') for s in steps[:-1]) and browser == 'succeeded'
    state = 'ambiguous' if ambiguous else 'failed' if failed else 'complete' if complete else 'partial' if cleanup_failed and root_ok else 'pending' if collecting else 'partial'
    return dict(kind='checkout', state=state, collecting=collecting, truncated=truncated,
                steps=educate(steps, 'checkout'), order_confirmed=root_ok and not ambiguous,
                new_order_confirmed=new_order and not ambiguous, reused_order_confirmed=reused_order and not ambiguous,
                rollback_observed=rollback and not ambiguous, cleanup_failed=bool(cleanup_failed) and not ambiguous, payment_state=payment_state if not ambiguous else 'ambiguous',
                payment_duration_ms=payment_duration if not ambiguous else None,
                browser={'checkout': browser, 'basket_cleared': action.basket_cleared},
                events=[public(r) for r in rows])
