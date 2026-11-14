#!/usr/bin/env python3
"""Observe pod identities in real responses through the Kubernetes Service."""
from concurrent.futures import ThreadPoolExecutor
from urllib.request import urlopen
from uuid import uuid4
import argparse
import time

parser = argparse.ArgumentParser()
parser.add_argument("--base", default="http://localhost:8080")
parser.add_argument("--expect", type=int, default=3)
args = parser.parse_args()

def request(_):
    with urlopen(f"{args.base.rstrip('/')}/api/orders/{uuid4()}", timeout=15) as response:
        assert response.status == 200
        return response.headers.get("X-Served-By")

pods = set()
deadline = time.monotonic() + 20
with ThreadPoolExecutor(4) as executor:
    while True:
        pods.update(executor.map(request, range(20)))
        if len(pods) >= args.expect or time.monotonic() >= deadline:
            break
        # Pod readiness precedes EndpointSlice/kube-proxy propagation slightly.
        time.sleep(1)
assert None not in pods, "Missing serving pod header"
print("Observed serving pods:", *sorted(pods), sep="\n  ")
assert len(pods) >= args.expect, f"Expected {args.expect} different pods, observed {len(pods)}. Check Service endpoints and retry."
