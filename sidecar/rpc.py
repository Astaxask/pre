"""JSON-RPC 2.0 dispatcher for the PRE sidecar."""

import json
import sys
from dataclasses import dataclass
from typing import Any, Callable, Awaitable


@dataclass
class RPCRequest:
    method: str
    params: dict[str, Any]
    id: str | int | None


# Standard JSON-RPC 2.0 error codes
PARSE_ERROR = -32700
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603


def parse_request(raw: str) -> RPCRequest:
    """Parse a raw JSON-RPC 2.0 request string."""
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        raise ValueError(f"Parse error: {e}") from e

    if not isinstance(data, dict):
        raise ValueError("Request must be a JSON object")

    method = data.get("method")
    if not isinstance(method, str):
        raise ValueError("Missing or invalid 'method'")

    params = data.get("params", {})
    if not isinstance(params, dict):
        raise ValueError("'params' must be an object")

    return RPCRequest(
        method=method,
        params=params,
        id=data.get("id"),
    )


def build_response(id: str | int | None, result: Any) -> str:
    """Build a JSON-RPC 2.0 success response."""
    return json.dumps({
        "jsonrpc": "2.0",
        "result": result,
        "id": id,
    })


def build_error(id: str | int | None, code: int, message: str) -> str:
    """Build a JSON-RPC 2.0 error response."""
    return json.dumps({
        "jsonrpc": "2.0",
        "error": {"code": code, "message": message},
        "id": id,
    })


class RPCDispatcher:
    """Routes JSON-RPC method calls to registered handler functions."""

    def __init__(self) -> None:
        self._handlers: dict[str, Callable[..., Awaitable[Any]]] = {}

    def register(self, method: str, handler: Callable[..., Awaitable[Any]]) -> None:
        self._handlers[method] = handler

    async def dispatch(self, raw: str) -> str:
        """Parse, route, and return a JSON-RPC response string."""
        try:
            req = parse_request(raw)
        except ValueError as e:
            return build_error(None, PARSE_ERROR, str(e))

        handler = self._handlers.get(req.method)
        if handler is None:
            return build_error(req.id, METHOD_NOT_FOUND, f"Method not found: {req.method}")

        try:
            result = await handler(**req.params)
            return build_response(req.id, result)
        except TypeError as e:
            return build_error(req.id, INVALID_PARAMS, f"Invalid params: {e}")
        except Exception as e:
            print(f"[sidecar] Internal error in {req.method}: {e}", file=sys.stderr)
            return build_error(req.id, INTERNAL_ERROR, str(e))
