# Verification record

Verified on 14 November 2026. Existing KubeVerse source files were not modified.

## Executed successfully

- **13 automated tests passed** using real PostgreSQL 18.6 and Redis 8.0.5, with separate Uvicorn processes and actual loopback HTTP requests. Tests cover PostgreSQL catalogue retrieval, Redis basket creation/updates, successful and declined checkout, connection refusal, persisted orders across process replacement, concurrent idempotency across checkout processes, basket freezes, request-ID propagation, health endpoints and manifest/source mappings.
- **Frontend TypeScript check and Vite production build passed.** The generated application JS was approximately 227 kB before gzip.
- **Browser workflow passed:** product detail → add to basket → quantity change → page refresh retaining the basket → checkout → confirmation → previous orders. No browser console warnings or errors were recorded during this workflow.
- **Responsive catalogue checks passed** at 320, 768, 1024 and 1440 pixels: no horizontal document overflow. Bundled images loaded successfully.
- **Native Nginx 1.28.3 syntax check and real proxy smoke test passed**, serving the production frontend build on port 8080. The temporary native configuration substituted loopback API addresses and `/tmp` filesystem paths for container addresses/paths. The application API locations, proxy headers and request-ID rules came from the shipped template. This validates routing but does not claim container DNS or image verification.
- **All 20 Kubernetes resources passed strict kubeconform validation** against Kubernetes 1.34 schemas: 20 valid, zero invalid/errors/skipped.
- **Both Compose configurations passed `docker compose config --quiet`**, including the database-port test override.
- Shell scripts passed Bash syntax checks; Python sources compiled successfully.

## Genuine checkout evidence

The browser saved order `0c324e53-3b4a-4e5a-a01a-e94fc0ac9d37`, total **15,800 pence**, using request ID `b71e6a4d-0493-4677-8d2f-7e272a96e656`.

- [checkout-events.jsonl](checkout-events.jsonl): 13 actual correlated events from Cart, Product, Payment and Checkout processes.
- [checkout-database.json](checkout-database.json): the actual persisted PostgreSQL row, queried after browser confirmation.
- [checkout.jpg](checkout.jpg): browser confirmation screenshot.
- [storefront.jpg](storefront.jpg): storefront screenshot with the PostgreSQL-backed catalogue.

The production-proxy smoke test also saved order `23aae16f-279d-498c-a0fe-b8c45e572cc4`, request `e7fc465f-fd42-43d5-932b-04804fb47396`, and verified duplicate replay returned the same order and cleared the Redis basket.

These are local process/database observations, not Kubernetes traces. No pod identities, cluster requests, financial transactions or metrics were fabricated.

## Docker and Kubernetes runtime verification passed

After the user installed Docker, all five application images built successfully. The full Compose stack became healthy and passed checkout, order persistence, duplicate replay and basket cleanup (order `2962997f-98da-4a9f-950b-ba9052e4bee1`). Compose was then stopped, retaining its volumes.

A real two-node kind Kubernetes 1.34 cluster named `minishop` was created. All seven Deployments reached Ready and both PVCs were Bound. `scripts/verify-k8s.sh` then passed the complete sequence. Its actual output is saved in [kubernetes-verification.txt](kubernetes-verification.txt):

- Successful checkout and idempotent replay through the frontend reverse proxy and real Kubernetes Service DNS.
- Scaling from one to three Ready Checkout replicas; responses came from `checkout-api-68694fd795-f4dnl`, `checkout-api-68694fd795-ps2zp` and `checkout-api-68694fd795-xp77x`.
- Deletion of `checkout-api-68694fd795-f4dnl`, creation of a replacement and restoration of three Ready replicas; checkout still succeeded afterward.
- Actual HTTP 402 payment decline, no completed order, and retained Redis basket.
- Restoring Payment and completing checkout successfully.
- Reset to healthy payment settings, 100 ms delay and one Ready Checkout replica.

Additional genuine cluster evidence:

- [kubernetes-checkout-events.jsonl](kubernetes-checkout-events.jsonl): 50 actual correlated events for request `6d7ee53a-f8dd-4c94-ba18-5f296aab7459`.
- [kubernetes-order.json](kubernetes-order.json): PostgreSQL row for order `dec943c5-e91d-4bb5-9146-aee5c5c994f3`.
- [kubernetes-integration.json](kubernetes-integration.json): real Deployment UIDs and **10 real traffic edges parsed by KubeVerse’s unchanged `LiveCluster` adapter**.
- [kubernetes-storefront.jpg](kubernetes-storefront.jpg): the React shop opened through the cluster’s localhost:8080 port-forward, without browser console warnings/errors.

Live checks exposed and fixed Nginx’s need for fully qualified Kubernetes upstream names, inherited university DNS search-domain timeouts (API pods now use `ndots:1`), Docker 29/older-kind multi-platform import handling, and the short delay between Pod readiness and Service endpoint propagation. Smoke tests can safely retry transient checkout 502/503/504 responses with the **same** idempotency key; every retry is printed. The final successful scenario run did not require such a retry.

The cluster and frontend port-forward were left running at http://localhost:8080. In this environment kubectl was downloaded to `/tmp/minishop-bin/kubectl`; add `/tmp/minishop-bin` to PATH when running the demo scripts from a new terminal, or install kubectl normally.

## KubeVerse limitation

MiniShop implements the existing adapter’s labels, container names and log fields. Source inspection found pre-existing KubeVerse frontend incompatibilities with the initial `SOURCE` event and stripped pod labels. See [INTEGRATION.md](../INTEGRATION.md). These were documented rather than changed, as requested. End-to-end KubeVerse rendering therefore remains outside the verified result.
