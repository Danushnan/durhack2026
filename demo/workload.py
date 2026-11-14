"""HTTP workload and structured traffic logs for the KubeVerse demo."""

import concurrent.futures
import json
import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

SERVICE = os.environ["SERVICE"]
DEPENDENCIES = os.getenv("DEPENDENCIES", "").split()
POD = os.environ["POD_NAME"]


def call(target, trace_id):
    started = time.monotonic()
    try:
        with urlopen(Request(f"http://{target}/work", headers={"X-Trace-Id": trace_id}),
                     timeout=4) as response:
            status = response.status
    except HTTPError as error:
        status = error.code
        error.close()
    except (URLError, TimeoutError):
        status = 504
    print(json.dumps({
        "source": SERVICE, "target": target, "source_pod": POD,
        "status": status, "duration_ms": round((time.monotonic() - started) * 1000, 1),
        "trace_id": trace_id, "timestamp_ms": time.time_ns() // 1_000_000,
    }), flush=True)
    return status


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            self.send_response(200)
        elif self.path == "/work":
            time.sleep(int(os.getenv("DELAY_MS", "0")) / 1000)
            statuses = [call(target, self.headers.get("X-Trace-Id", ""))
                        for target in DEPENDENCIES]
            self.send_response(502 if any(status >= 400 for status in statuses) else 200)
        else:
            self.send_response(404)
        self.end_headers()

    def log_message(self, *_args):
        pass


if __name__ == "__main__":
    if SERVICE == "traffic":
        import uuid

        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            pending = set()
            while True:
                pending = {job for job in pending if not job.done()}
                if len(pending) < 8:
                    pending.add(pool.submit(call, "gateway", uuid.uuid4().hex))
                time.sleep(0.25)
    else:
        ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()

