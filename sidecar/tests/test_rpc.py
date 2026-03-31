"""Tests for the JSON-RPC 2.0 dispatcher."""

import asyncio
import json
import pytest

import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from rpc import (
    RPCDispatcher,
    parse_request,
    build_response,
    build_error,
    PARSE_ERROR,
    METHOD_NOT_FOUND,
    INTERNAL_ERROR,
)


class TestParseRequest:
    def test_valid_request(self):
        raw = json.dumps({"jsonrpc": "2.0", "method": "embed", "params": {"text": "hello"}, "id": 1})
        req = parse_request(raw)
        assert req.method == "embed"
        assert req.params == {"text": "hello"}
        assert req.id == 1

    def test_missing_method(self):
        raw = json.dumps({"jsonrpc": "2.0", "params": {}, "id": 1})
        with pytest.raises(ValueError, match="method"):
            parse_request(raw)

    def test_invalid_json(self):
        with pytest.raises(ValueError, match="Parse error"):
            parse_request("not json {{{")

    def test_default_params(self):
        raw = json.dumps({"jsonrpc": "2.0", "method": "ping", "id": 1})
        req = parse_request(raw)
        assert req.params == {}


class TestBuildResponse:
    def test_success_response(self):
        resp = build_response(1, {"result": "ok"})
        data = json.loads(resp)
        assert data["jsonrpc"] == "2.0"
        assert data["result"] == {"result": "ok"}
        assert data["id"] == 1

    def test_error_response(self):
        resp = build_error(1, PARSE_ERROR, "bad json")
        data = json.loads(resp)
        assert data["jsonrpc"] == "2.0"
        assert data["error"]["code"] == PARSE_ERROR
        assert data["error"]["message"] == "bad json"
        assert data["id"] == 1


class TestDispatcher:
    @pytest.fixture
    def dispatcher(self):
        d = RPCDispatcher()

        async def echo(**kwargs):
            return kwargs

        async def fail(**kwargs):
            raise RuntimeError("intentional error")

        d.register("echo", echo)
        d.register("fail", fail)
        return d

    def test_dispatch_success(self, dispatcher):
        raw = json.dumps({"jsonrpc": "2.0", "method": "echo", "params": {"msg": "hi"}, "id": 1})
        result = asyncio.get_event_loop().run_until_complete(dispatcher.dispatch(raw))
        data = json.loads(result)
        assert data["result"] == {"msg": "hi"}

    def test_dispatch_method_not_found(self, dispatcher):
        raw = json.dumps({"jsonrpc": "2.0", "method": "nonexistent", "params": {}, "id": 2})
        result = asyncio.get_event_loop().run_until_complete(dispatcher.dispatch(raw))
        data = json.loads(result)
        assert data["error"]["code"] == METHOD_NOT_FOUND

    def test_dispatch_internal_error(self, dispatcher):
        raw = json.dumps({"jsonrpc": "2.0", "method": "fail", "params": {}, "id": 3})
        result = asyncio.get_event_loop().run_until_complete(dispatcher.dispatch(raw))
        data = json.loads(result)
        assert data["error"]["code"] == INTERNAL_ERROR
        assert "intentional error" in data["error"]["message"]

    def test_dispatch_parse_error(self, dispatcher):
        result = asyncio.get_event_loop().run_until_complete(dispatcher.dispatch("not json"))
        data = json.loads(result)
        assert data["error"]["code"] == PARSE_ERROR
