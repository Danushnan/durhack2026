#!/usr/bin/env python3
"""Bounded real MiniShop traffic; shares the operator's single-worker workflow."""
import argparse
import asyncio
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from demo_control.traffic import Traffic

async def main(args):
    worker = Traffic(args.base)
    worker.start(args.rps, args.count)
    try:
        await worker.task
    finally:
        await worker.stop()
        print(worker.state)

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', default='http://127.0.0.1:8080')
    parser.add_argument('--rps', type=float, default=1)
    parser.add_argument('--count', type=int, default=100)
    args = parser.parse_args()
    if not .2 <= args.rps <= 2 or not 5 <= args.count <= 300:
        parser.error('Use 0.2..2 requests/s and 5..300 requests')
    try:
        asyncio.run(main(args))
    except KeyboardInterrupt:
        pass
