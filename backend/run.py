"""Start Uvicorn with the event loop required by Psycopg on Windows."""

import asyncio

import uvicorn


def event_loop(use_subprocess=False):
    return asyncio.SelectorEventLoop()


if __name__ == "__main__":
    uvicorn.run("main:app", port=8000, loop="run:event_loop")
