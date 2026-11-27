# ========= Copyright 2025-2026 @ Eigent.ai All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2025-2026 @ Eigent.ai All Rights Reserved. =========

"""Acceptance test: an authenticated remote MCP installs and gets a 200.

The criterion is not "the column exists" and not "the unit test is green". It is
this: a remote server that refuses unauthenticated requests is written to the
config the agent actually loads, the real MCP client connects, and the server
answers 200 because the header arrived.

The chain:

    add_mcp            -> ~/.eigent/mcp.json      (Brain writes it)
    read_mcp_config    -> the dict the agent loads
    MCPToolkit.connect -> camel -> streamable_http + headers
    guarded server     -> 200 + tools/list

The server is real HTTP; a mocked client would pass even if the header were
dropped, which is the exact failure this exists to catch.
"""

from __future__ import annotations

import asyncio
import socket
import threading
import time
from pathlib import Path

import pytest
import uvicorn
from mcp.server.fastmcp import FastMCP

from app.service import mcp_config
from app.service.mcp_config import (
    McpConfigError,
    add_mcp,
    read_mcp_config,
    update_mcp,
    write_mcp_config,
)

API_KEY = "s3cret-header-value"


class _AuthGate:
    """ASGI wrapper that rejects anything without the expected header."""

    def __init__(self, app, key: str) -> None:
        self.app = app
        self.key = key
        self.authenticated = 0
        self.rejected = 0

    async def __call__(self, scope, receive, send):  # noqa: ANN001
        if scope["type"] == "http":
            headers = dict(scope.get("headers") or [])
            if headers.get(b"x-api-key", b"").decode() != self.key:
                self.rejected += 1
                await send(
                    {
                        "type": "http.response.start",
                        "status": 401,
                        "headers": [(b"content-type", b"application/json")],
                    }
                )
                await send(
                    {
                        "type": "http.response.body",
                        "body": b'{"error":"invalid api key"}',
                    }
                )
                return
            self.authenticated += 1
        await self.app(scope, receive, send)


@pytest.fixture(scope="module")
def guarded_server():
    """A streamable-http MCP server that only answers with the right header."""
    mcp = FastMCP("guarded", json_response=True)

    @mcp.tool()
    def add(a: int, b: int) -> int:
        """Add two numbers."""
        return a + b

    gate = _AuthGate(mcp.streamable_http_app(), API_KEY)

    probe = socket.socket()
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]
    probe.close()

    server = uvicorn.Server(
        uvicorn.Config(gate, host="127.0.0.1", port=port, log_level="error")
    )
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    for _ in range(200):
        if server.started:
            break
        time.sleep(0.05)
    assert server.started, "guarded MCP server did not start"

    yield gate, f"http://127.0.0.1:{port}/mcp"

    server.should_exit = True
    thread.join(timeout=10)


@pytest.fixture
def config_file(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    """Point Brain's config at a throwaway file instead of ~/.eigent."""
    target = tmp_path / "mcp.json"
    monkeypatch.setattr(mcp_config, "MCP_CONFIG_DIR", tmp_path)
    monkeypatch.setattr(mcp_config, "MCP_CONFIG_PATH", target)
    return target


def _connect(config: dict, timeout: float = 20) -> list[str]:
    """Walk the runtime path: config dict -> camel -> tools."""
    from camel.toolkits import MCPToolkit

    async def run() -> list[str]:
        toolkit = MCPToolkit(config_dict=config, timeout=timeout)
        await toolkit.connect()
        try:
            return [tool.get_function_name() for tool in toolkit.get_tools()]
        finally:
            await toolkit.disconnect()

    return asyncio.run(run())


def test_an_authenticated_remote_server_installs_and_connects(
    guarded_server, config_file: Path
) -> None:
    gate, url = guarded_server
    before_auth, before_reject = gate.authenticated, gate.rejected

    # This is what the store's install row produces once the user has answered
    # the form: the URL plus the header the catalogue declared.
    add_mcp("guarded", {"url": url, "headers": {"x-api-key": API_KEY}})

    on_disk = config_file.read_text(encoding="utf-8")
    assert "x-api-key" in on_disk
    assert "{{" not in on_disk

    tools = _connect(read_mcp_config())

    assert "add" in tools
    assert gate.authenticated > before_auth, "the server answered 200 at least once"
    assert gate.rejected == before_reject, "no unauthenticated request was sent"


def test_without_the_header_the_same_server_refuses(
    guarded_server, config_file: Path
) -> None:
    """Proves the test above is not passing for free."""
    gate, url = guarded_server
    before = gate.rejected

    with pytest.raises(McpConfigError):
        add_mcp("guarded", {"url": url, "headers": {"x-api-key": ""}})

    # Bypass the guard, which is what a config written before this fix looks
    # like on disk today.
    write_mcp_config({"mcpServers": {"guarded": {"url": url, "headers": {"x-api-key": ""}}}})

    with pytest.raises(Exception):
        _connect(read_mcp_config(), timeout=3)

    assert gate.rejected > before


def test_a_catalogue_hint_is_refused_before_it_is_sent(config_file: Path) -> None:
    with pytest.raises(McpConfigError) as failure:
        add_mcp(
            "guarded",
            {
                "url": "https://mcp.example.com/mcp",
                "headers": {"x-api-key": "{{go get one at exa.ai}}"},
            },
        )

    assert "x-api-key" in str(failure.value)
    assert not config_file.exists() or "{{" not in config_file.read_text(
        encoding="utf-8"
    )


def test_a_dollar_reference_is_refused_before_it_is_sent(config_file: Path) -> None:
    """The spelling the three copies used to disagree about.

    `${ACME_KEY}` is a host-side reference, not a value. It was known to the
    installer and unknown to this gate and to the scanner, which is exactly how
    a "handled" case still reaches the wire.
    """
    with pytest.raises(McpConfigError) as failure:
        add_mcp(
            "guarded",
            {
                "url": "https://mcp.example.com/mcp",
                "headers": {"Authorization": "${ACME_KEY}"},
            },
        )

    assert "Authorization" in str(failure.value)
    assert not config_file.exists() or "${" not in config_file.read_text(
        encoding="utf-8"
    )


def test_an_empty_header_value_is_refused_with_its_name(config_file: Path) -> None:
    with pytest.raises(McpConfigError) as failure:
        add_mcp("guarded", {"url": "https://mcp.example.com/mcp", "headers": {"x-api-key": ""}})

    assert "x-api-key" in str(failure.value)
    assert "no value" in str(failure.value)


def test_headers_without_a_url_are_refused(config_file: Path) -> None:
    with pytest.raises(McpConfigError):
        add_mcp(
            "local",
            {"command": "npx", "args": ["-y", "pkg"], "headers": {"x-api-key": "abc"}},
        )


def test_an_update_cannot_reintroduce_a_hint(config_file: Path) -> None:
    add_mcp("guarded", {"url": "https://mcp.example.com/mcp", "headers": {"x-api-key": API_KEY}})

    with pytest.raises(McpConfigError):
        update_mcp(
            "guarded",
            {"url": "https://mcp.example.com/mcp", "headers": {"x-api-key": "{{where}}"}},
        )

    stored = read_mcp_config()["mcpServers"]["guarded"]
    assert stored["headers"]["x-api-key"] == API_KEY


def test_headers_survive_the_read_normalisation(config_file: Path) -> None:
    add_mcp(
        "guarded",
        {
            "url": "https://mcp.example.com/mcp",
            "headers": {"x-api-key": API_KEY, "x-tenant": "acme"},
        },
    )

    stored = read_mcp_config()["mcpServers"]["guarded"]
    assert stored["headers"] == {"x-api-key": API_KEY, "x-tenant": "acme"}
