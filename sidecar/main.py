"""PRE Sidecar — Python process for ML/stats, communicates via Unix socket + JSON-RPC 2.0."""

import asyncio
import os
import signal
import sys

from rpc import RPCDispatcher
from handlers.embed import embed
from handlers.similarity_search import similarity_search, upsert_vector
from handlers.patterns import detect_patterns
from handlers.forecast import forecast_domain, estimate_impact, run_simulation

SOCKET_PATH = os.environ.get("PRE_SIDECAR_SOCK", "/tmp/pre-sidecar.sock")


async def handle_client(
    reader: asyncio.StreamReader,
    writer: asyncio.StreamWriter,
    dispatcher: RPCDispatcher,
) -> None:
    """Handle a single client connection. Reads newline-delimited JSON-RPC messages."""
    peer = writer.get_extra_info("peername") or "unix"
    print(f"[sidecar] Client connected: {peer}", file=sys.stderr)

    try:
        while True:
            line = await reader.readline()
            if not line:
                break

            raw = line.decode("utf-8").strip()
            if not raw:
                continue

            response = await dispatcher.dispatch(raw)
            writer.write((response + "\n").encode("utf-8"))
            await writer.drain()
    except asyncio.CancelledError:
        pass
    except Exception as e:
        print(f"[sidecar] Client error: {e}", file=sys.stderr)
    finally:
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:
            pass
        print(f"[sidecar] Client disconnected: {peer}", file=sys.stderr)


async def ping() -> str:
    """Health check — returns 'pong'."""
    return "pong"


async def main() -> None:
    # Clean up stale socket
    if os.path.exists(SOCKET_PATH):
        os.unlink(SOCKET_PATH)

    dispatcher = RPCDispatcher()
    dispatcher.register("ping", ping)
    dispatcher.register("embed", embed)
    dispatcher.register("similarity_search", similarity_search)
    dispatcher.register("upsert_vector", upsert_vector)
    dispatcher.register("detect_patterns", detect_patterns)
    dispatcher.register("forecast_domain", forecast_domain)
    dispatcher.register("estimate_impact", estimate_impact)
    dispatcher.register("run_simulation", run_simulation)

    server = await asyncio.start_unix_server(
        lambda r, w: handle_client(r, w, dispatcher),
        path=SOCKET_PATH,
    )

    print(f"[sidecar] Listening on {SOCKET_PATH}", file=sys.stderr)

    # Handle SIGTERM gracefully
    loop = asyncio.get_running_loop()
    stop_event = asyncio.Event()

    def _signal_handler() -> None:
        print("[sidecar] Received shutdown signal", file=sys.stderr)
        stop_event.set()

    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, _signal_handler)

    await stop_event.wait()

    print("[sidecar] Shutting down...", file=sys.stderr)
    server.close()
    await server.wait_closed()

    # Clean up socket file
    if os.path.exists(SOCKET_PATH):
        os.unlink(SOCKET_PATH)

    print("[sidecar] Stopped", file=sys.stderr)


if __name__ == "__main__":
    asyncio.run(main())
