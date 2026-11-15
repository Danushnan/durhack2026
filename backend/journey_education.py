"""Reviewed MiniShop teaching copy. General purpose is separate from observed facts."""
BASKET = {
    "mutation": ("Ask the shop to add an item", "The website handles clicks; Cart is a backend service that manages baskets.", "Sending the change to Cart lets the server check it before accepting it.", "An HTTP request is a message one program sends to another."),
    "product": ("Check the product", "Product owns the catalogue, so Cart asks it for current item information.", "Cart needs availability information before it can decide whether to accept this change.", "Microservices are small programs with separate responsibilities."),
    "catalogue": ("Look in the catalogue database", "PostgreSQL stores the shop’s product records; Product reads them here.", "The basket check uses stored product information rather than trusting the website.", "A database stores information so services can retrieve it later."),
    "redis": ("Try to update the basket", "Redis remembers basket data. Cart runs an atomic basket change there.", "An atomic change avoids two requests to the same basket overwriting each other. The operation’s completion alone does not prove the change was accepted.", "Atomic means the data store handles the change as one indivisible operation."),
    "result": ("Find out whether it worked", "Cart returns the overall result after checking the product and attempting the change.", "This final response determines whether Cart accepted the basket change; a completed Redis wrapper is not enough.", "An HTTP status describes the response: 2xx is success; 4xx is rejection; 5xx is a server-side failure."),
    "refresh": ("Ask for the updated basket", "Changing a basket and reading its display are two separate requests in MiniShop.", "The website needs the server’s basket contents before it can update the display accurately.", "The refresh has its own request ID; both requests belong to this one click."),
    "basket": ("Read the saved basket", "Cart reads the basket from Redis, where its item identifiers and quantities are remembered.", "The display should reflect server data, including changes that another request may have made.", None),
    "display-products": ("Make the basket readable", "Redis stores basket references; Product supplies the catalogue details used in the display.", "The website needs product details and prices to present the basket to you.", "A service can combine information from more than one data store without those stores calling each other."),
    "browser": ("Show the basket on the website", "The frontend turns the returned basket into the page you see.", "A change can be accepted even if the separate refresh fails. Browser feedback and backend observations answer different questions.", "Frontend means the part of the application running in your browser."),
}


def educate(steps, kind="add_to_basket"):
    templates = BASKET if kind == "add_to_basket" else CHECKOUT
    for step in steps:
        heading, why, matters, term = templates[step["key"]]
        step.update(heading=heading, what=step["description"], why=why, matters=matters, term=term)
        step["evidence_label"] = ("Browser-reported" if step["basis"] == "browser" else
                                  "Inferred" if step["basis"] == "inferred" else
                                  "Observed" if step["event_ids"] else "Partial")
    return steps


CHECKOUT = {
    "checkout-request": ("Ask Checkout to place the order", "The website cannot coordinate an order by itself. Checkout brings the basket, catalogue, payment and order records together.", "One coordinator decides whether this shopping action can finish safely.", "A backend service is a program on the server, separate from the page in your browser."),
    "snapshot": ("Take a stable basket snapshot", "Cart owns the basket, so Checkout asks Cart for its current contents and a short-lived lock.", "The order needs a consistent basket while its details are being checked.", "A snapshot is a copy of data at a particular point; a lock temporarily prevents conflicting changes."),
    "freeze": ("Protect the basket during checkout", "Cart uses Redis to coordinate the basket lock and read the saved basket.", "Concurrent changes must not silently alter the order being checked. The freeze operation can still lead to a rejected checkout.", "Redis is the data store MiniShop uses to remember and coordinate baskets."),
    "validate": ("Check items and quantities", "Product supplies the current catalogue. Checkout checks that the requested items and quantities are available.", "Checking again avoids accepting an order based only on an older basket display. MiniShop does not decrement stock here.", "Validation means checking that the requested data satisfies the shop’s rules."),
    "payment": ("Ask for a simulated payment", "The Payment Service returns a test acceptance or decline; Checkout waits for it before saving a new order.", "A decline stops this attempt. This selected call’s duration is separate from rolling service health and pod readiness.", "A Kubernetes pod runs service code. A ready pod can still respond slowly or reject a business request."),
    "transaction": ("Finish the order transaction", "PostgreSQL groups order changes in a transaction and also stores previously completed orders for safe retries.", "A commit makes changes durable; a rollback discards this transaction’s changes. The broad wrapper includes other service calls, not just SQL.", "Idempotency means a retry can return the saved result instead of performing the shopping operation again."),
    "finalise": ("Ask Cart to tidy up", "Checkout asks Cart to finalise the basket after it knows whether the order transaction completed.", "Cleanup follows the result: the normal path requests clearing a matching basket; the rollback path requests releasing its lock. The call alone does not prove either data outcome.", "A cleanup failure can happen after an order was already saved; it does not undo that order."),
    "finish-store": ("Finish basket coordination in Redis", "Cart owns the Redis keys and performs the requested finalisation there.", "Version and lock checks protect newer basket changes. A completed wrapper does not prove the basket was emptied.", "A version identifies which basket revision the order used."),
    "confirmation": ("Show the order outcome", "The frontend turns Checkout’s response into a confirmation page or an error message.", "The browser report is separate from backend evidence. If the response is lost, the saved checkout key makes a retry safer.", "The checkout idempotency key is not the journey action ID or the HTTP request ID."),
}
