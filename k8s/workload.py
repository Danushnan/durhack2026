"""Kuebec live-demo workload: serves HTTP on :8080, calls its dependencies, logs one JSON line per call."""
import json, os, random, threading, time, urllib.error, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

NAME = os.environ["SERVICE"]
CALLS = json.loads(os.environ.get("CALLS", "[]"))  # [["cart", 2.0], ["redis.data", 1.5]]: target, requests/second
failing = {}                                        # target -> time of its last failed call

def degraded():
    return any(time.time() - t < 3 for t in failing.values())

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        # Readiness probe: am I up? Requests: can I do my job (are the things I call working)?
        code = 200 if self.path == "/healthz" or not degraded() else 500
        time.sleep(random.uniform(0.01, 0.04))
        self.send_response(code)
        self.end_headers()
        self.wfile.write(b"ok" if code == 200 else b"a dependency is failing")

    def log_message(self, *args):
        pass

def call(target, rps):
    url = f"http://{target}:8080/"
    while True:
        time.sleep(random.expovariate(rps))
        started = time.monotonic()
        try:
            with urllib.request.urlopen(url, timeout=2) as response:
                status = response.status
        except urllib.error.HTTPError as error:
            status = error.code      # it answered, with an error
        except Exception:
            status = 503             # nobody answered (no ready Pods, connection refused, timeout)
        if status >= 400:
            failing[target] = time.time()
        else:
            failing.pop(target, None)
        print(json.dumps({"source": NAME, "target": target, "status": status,
                          "latency_ms": round((time.monotonic() - started) * 1000, 1),
                          "timestamp_ms": int(time.time() * 1000)}), flush=True)

for target, rps in CALLS:
    threading.Thread(target=call, args=(target, rps), daemon=True).start()
ThreadingHTTPServer(("", 8080), Handler).serve_forever()
