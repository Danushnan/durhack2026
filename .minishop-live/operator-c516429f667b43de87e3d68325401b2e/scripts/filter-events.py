#!/usr/bin/env python3
import json
import sys
from uuid import UUID

if len(sys.argv) != 2:
    raise SystemExit("Usage: scripts/filter-events.py REQUEST_UUID < logs.jsonl")
request_id = str(UUID(sys.argv[1]))
for line in sys.stdin:
    try:
        event = json.loads(line)
    except ValueError:
        continue
    if event.get("request_id") == request_id:
        print(json.dumps(event))
