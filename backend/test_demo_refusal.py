"""Synthetic map events never pass through measured observations/history."""
import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi import HTTPException, Request
import main


def test_refusal_broadcast_is_separate_from_telemetry(monkeypatch):
    ingest = Mock(side_effect=AssertionError('synthetic event entered observation pipeline'))
    monkeypatch.setattr(main, 'live', SimpleNamespace(telemetry=SimpleNamespace(ingest=ingest)))
    broadcast = AsyncMock()
    monkeypatch.setattr(main, 'broadcast', broadcast)
    monkeypatch.setattr(main, 'telemetry_clients', {object()})
    request = Request({'type': 'http', 'method': 'POST', 'scheme': 'http', 'path': '/',
                       'headers': [], 'server': ('127.0.0.1', 8000), 'client': ('127.0.0.1', 123)})
    body = main.DemoRefusal(source='minishop/minishop-web', target='minishop/cart-api', context='test')
    assert asyncio.run(main.show_demo_refusal(body, request)) == {'sent': 1}
    broadcast.assert_awaited_once_with([], {'type': 'DEMO_REFUSAL', **body.model_dump()})
    ingest.assert_not_called()


def test_refusal_requires_local_demo_access(monkeypatch):
    monkeypatch.setattr(main, 'telemetry_clients', {object()})
    request = Request({'type': 'http', 'method': 'POST', 'scheme': 'http', 'path': '/',
                       'headers': [], 'server': ('127.0.0.1', 8000), 'client': ('192.0.2.1', 123)})
    with pytest.raises(HTTPException) as error:
        asyncio.run(main.show_demo_refusal(main.DemoRefusal(source='a', target='b', context='test'), request))
    assert error.value.status_code == 403
